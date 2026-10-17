// File: task-core.js
(function () {
  'use strict';

  // 既存の小窓が確認する接続互換性の番号。
  const VERSION = 'v4.8';
  const BUILD = 'v4.10.1';

  const SERVER_VERSION = 'v4.3';
  const SYNC_PROTOCOL = 'task-sync-v1';
  const DB_NAME = 'taskapp-unified';
  const URL_KEY = 'gasUrl_v1';
  const TOKEN_KEY = 'gasTok_v1';
  const CHANNEL_NAME = 'task-unified-state';
  const NETWORK_LOCK = 'taskapp-unified-remote-v1';
  const REQUEST_TIMEOUT_MS = 60000;
  const DIAGNOSTIC_KEY = 'read-receipt-checks-v1';
  const DIAGNOSTIC_LIMIT = 8;
  const RESPONSE_INFO = Symbol('response-info');
  const SKIPPED = Symbol('skipped');

  const READ_ACTIONS = [
    'load',
    'history',
    'preview',
    'check'
  ];

  const KNOWN_STATUSES = [
    'saved',
    'committed',
    'duplicate',
    'recovered',
    'done',
    'already',
    'denied',
    'invalid',
    'error',
    'busy',
    'conflict',
    'indeterminate',
    'needs_setup',
    'badmode',
    'nosetup'
  ];

  function uuid() {
    if (window.crypto && window.crypto.randomUUID) {
      return window.crypto.randomUUID();
    }

    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(
      /[xy]/g,
      function (character) {
        const number = Math.random() * 16 | 0;

        return (
          character === 'x'
            ? number
            : number & 3 | 8
        ).toString(16);
      }
    );
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function emptyState() {
    return {
      snapshot: null,
      jobs: [],
      sequence: 0,
      transitions: [],
      savedAt: 0
    };
  }

  function checkedState(value) {
    if (value == null) {
      return emptyState();
    }

    if (
      !Array.isArray(value.jobs) ||
      !Array.isArray(value.transitions) ||
      !Number.isSafeInteger(value.sequence)
    ) {
      throw new Error(
        '端末の記録を読み取れません。データを消さずに確認してください。'
      );
    }

    return value;
  }

  function isObject(value) {
    return !!value &&
      typeof value === 'object' &&
      !Array.isArray(value);
  }

  function valueType(value) {
    if (value === undefined) {
      return 'なし';
    }

    if (value === null) {
      return 'null';
    }

    if (Array.isArray(value)) {
      return '配列';
    }

    switch (typeof value) {
      case 'object':
        return '項目の組';
      case 'string':
        return '文字列';
      case 'number':
        return '数値';
      case 'boolean':
        return '真偽値';
      default:
        return 'その他';
    }
  }

  function safeVersion(value) {
    if (
      typeof value === 'string' &&
      /^v\d+(?:\.\d+){0,4}(?:-\d+)?$/.test(value) &&
      value.length <= 40
    ) {
      return value;
    }

    return value == null ? 'なし' : '指定外';
  }

  function safeContentType(value) {
    const type = String(value || '')
      .split(';')[0]
      .trim()
      .toLowerCase();

    return [
      'application/json',
      'text/json',
      'text/plain',
      'text/html'
    ].indexOf(type) >= 0
      ? type
      : type
        ? 'その他'
        : 'なし';
  }

  function safeStatus(value) {
    return KNOWN_STATUSES.indexOf(value) >= 0
      ? value
      : value == null
        ? 'なし'
        : '指定外';
  }

  function safeAction(value) {
    return READ_ACTIONS.indexOf(value) >= 0
      ? value
      : 'その他';
  }

  function summarizeResponse(result, transport) {
    const source = isObject(result) ? result : {};
    const snapshot = isObject(source.snapshot) ? source.snapshot : {};
    const periodic = isObject(snapshot.periodic) ? snapshot.periodic : {};
    const history = isObject(source.history) ? source.history : {};
    const preview = isObject(source.preview) ? source.preview : {};
    const info = transport || {};

    return {
      format: info.format || '未確認',
      httpStatus: Number.isInteger(info.httpStatus)
        ? info.httpStatus
        : null,
      contentType: info.contentType || 'なし',
      rootType: valueType(result),
      ok: typeof source.ok === 'boolean' ? source.ok : null,
      status: safeStatus(source.status),
      app: safeVersion(source.app),
      build: safeVersion(source.build || snapshot.build),
      unchanged: source.unchanged === true,
      fields: [
        {
          name: 'snapshot',
          type: valueType(source.snapshot)
        },
        {
          name: 'snapshot.tasks',
          type: valueType(snapshot.tasks)
        },
        {
          name: 'snapshot.days',
          type: valueType(snapshot.days)
        },
        {
          name: 'snapshot.periodic',
          type: valueType(snapshot.periodic)
        },
        {
          name: 'snapshot.periodic.items',
          type: valueType(periodic.items)
        },
        {
          name: 'snapshot.undo',
          type: valueType(snapshot.undo)
        },
        {
          name: 'patch',
          type: valueType(source.patch)
        },
        {
          name: 'history.items',
          type: valueType(history.items)
        },
        {
          name: 'preview.items',
          type: valueType(preview.items)
        },
        {
          name: 'checks',
          type: valueType(source.checks)
        }
      ],
      taskCount: Array.isArray(snapshot.tasks)
        ? snapshot.tasks.length
        : null
    };
  }

  function receiveError(code, message, info, retryFull, issues) {
    const error = new Error(message);
    error.receiveCode = code;
    error.receiveInfo = info || null;
    error.retryFull = retryFull === true;
    error.receiveIssues = issues || [];
    return error;
  }

  function snapshotIssues(snapshot) {
    const issues = [];

    function expect(path, value, condition, expected) {
      if (!condition && issues.length < 20) {
        issues.push({
          field: path,
          expected: expected,
          actual: valueType(value)
        });
      }
    }

    expect(
      'snapshot',
      snapshot,
      isObject(snapshot),
      '項目の組'
    );

    if (!isObject(snapshot)) {
      return issues;
    }

    expect(
      'snapshot.tasks',
      snapshot.tasks,
      Array.isArray(snapshot.tasks),
      '配列'
    );

    expect(
      'snapshot.days',
      snapshot.days,
      isObject(snapshot.days),
      '項目の組'
    );

    expect(
      'snapshot.emptyDay',
      snapshot.emptyDay,
      typeof snapshot.emptyDay === 'string' && !!snapshot.emptyDay,
      '空でない文字列'
    );

    expect(
      'snapshot.today',
      snapshot.today,
      typeof snapshot.today === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(snapshot.today),
      '日付の文字列'
    );

    expect(
      'snapshot.fetchedAt',
      snapshot.fetchedAt,
      typeof snapshot.fetchedAt === 'string' &&
        Number.isFinite(Date.parse(snapshot.fetchedAt)),
      '取得日時の文字列'
    );

    expect(
      'snapshot.periodic',
      snapshot.periodic,
      isObject(snapshot.periodic),
      '項目の組'
    );

    if (isObject(snapshot.periodic)) {
      expect(
        'snapshot.periodic.items',
        snapshot.periodic.items,
        Array.isArray(snapshot.periodic.items),
        '配列'
      );

      expect(
        'snapshot.periodic.version',
        snapshot.periodic.version,
        typeof snapshot.periodic.version === 'string' &&
          !!snapshot.periodic.version,
        '空でない文字列'
      );

      expect(
        'snapshot.periodic.automatic',
        snapshot.periodic.automatic,
        typeof snapshot.periodic.automatic === 'boolean',
        '真偽値'
      );
    }

    expect(
      'snapshot.undo',
      snapshot.undo,
      isObject(snapshot.undo),
      '項目の組'
    );

    if (isObject(snapshot.undo)) {
      expect(
        'snapshot.undo.version',
        snapshot.undo.version,
        typeof snapshot.undo.version === 'string' &&
          !!snapshot.undo.version,
        '空でない文字列'
      );

      expect(
        'snapshot.undo.count',
        snapshot.undo.count,
        Number.isInteger(snapshot.undo.count) &&
          snapshot.undo.count >= 0,
        '0以上の整数'
      );

      expect(
        'snapshot.undo.titles',
        snapshot.undo.titles,
        Array.isArray(snapshot.undo.titles) &&
          snapshot.undo.titles.every(function (title) {
            return typeof title === 'string';
          }),
        '文字列の配列'
      );
    }

    if (Array.isArray(snapshot.tasks)) {
      snapshot.tasks.forEach(function (task, index) {
        if (issues.length >= 20) {
          return;
        }

        const prefix = 'snapshot.tasks[' + index + ']';

        expect(prefix, task, isObject(task), '項目の組');

        if (!isObject(task)) {
          return;
        }

        expect(
          prefix + '.taskId',
          task.taskId,
          typeof task.taskId === 'string' && !!task.taskId,
          '空でない文字列'
        );

        expect(
          prefix + '.title',
          task.title,
          typeof task.title === 'string',
          '文字列'
        );

        expect(
          prefix + '.due',
          task.due,
          typeof task.due === 'string',
          '文字列'
        );

        expect(
          prefix + '.date',
          task.date,
          typeof task.date === 'string',
          '文字列'
        );

        expect(
          prefix + '.hour',
          task.hour,
          task.hour === null ||
            (
              Number.isInteger(task.hour) &&
              task.hour >= 8 &&
              task.hour <= 22
            ),
          'nullまたは8～22の整数'
        );

        expect(
          prefix + '.order',
          task.order,
          task.order === null ||
            (
              typeof task.order === 'number' &&
              Number.isFinite(task.order)
            ),
          'nullまたは数値'
        );

        expect(
          prefix + '.row',
          task.row,
          Number.isInteger(task.row) && task.row >= 2,
          '2以上の整数'
        );

        expect(
          prefix + '.version',
          task.version,
          typeof task.version === 'string' && !!task.version,
          '空でない文字列'
        );
      });
    }

    return issues;
  }

  function requireSnapshot(snapshot, info) {
    const issues = snapshotIssues(snapshot);

    if (issues.length) {
      throw receiveError(
        'snapshot-shape',
        '保存先の返答に、必要なタスク一覧が含まれていません。',
        info || summarizeResponse({
          snapshot: snapshot
        }),
        true,
        issues
      );
    }
  }

  function validateReadResponse(action, result, forceFull) {
    const info = result[RESPONSE_INFO] || summarizeResponse(result);

    if (!result.ok) {
      throw receiveError(
        'server-rejection',
        String(result.message || '一覧を取得できませんでした。'),
        info,
        false
      );
    }

    if (result.unchanged === true) {
      const issues = [];

      if (action !== 'load') {
        issues.push({
          field: 'unchanged',
          expected: '一覧取得以外では使用しない',
          actual: 'true'
        });
      }

      if (forceFull) {
        issues.push({
          field: 'snapshot',
          expected: '全体取得要求への一覧',
          actual: '変更なしの返答'
        });
      }

      if (
        typeof result.revision !== 'string' ||
        !result.revision
      ) {
        issues.push({
          field: 'revision',
          expected: '空でない文字列',
          actual: valueType(result.revision)
        });
      }

      if (
        typeof result.fetchedAt !== 'string' ||
        !Number.isFinite(Date.parse(result.fetchedAt))
      ) {
        issues.push({
          field: 'fetchedAt',
          expected: '取得日時の文字列',
          actual: valueType(result.fetchedAt)
        });
      }

      if (issues.length) {
        throw receiveError(
          'unchanged-shape',
          '変更なしという返答を、現在の一覧と照合できませんでした。',
          info,
          true,
          issues
        );
      }

      return;
    }

    requireSnapshot(result.snapshot, info);

    const issues = [];

    function expect(path, value, condition, expected) {
      if (!condition) {
        issues.push({
          field: path,
          expected: expected,
          actual: valueType(value)
        });
      }
    }

    if (action === 'history') {
      expect(
        'history',
        result.history,
        isObject(result.history),
        '項目の組'
      );

      if (isObject(result.history)) {
        expect(
          'history.items',
          result.history.items,
          Array.isArray(result.history.items),
          '配列'
        );

        expect(
          'history.total',
          result.history.total,
          Number.isInteger(result.history.total) &&
            result.history.total >= 0,
          '0以上の整数'
        );
      }
    }

    if (action === 'preview') {
      expect(
        'preview',
        result.preview,
        isObject(result.preview),
        '項目の組'
      );

      if (isObject(result.preview)) {
        expect(
          'preview.items',
          result.preview.items,
          Array.isArray(result.preview.items),
          '配列'
        );

        expect(
          'preview.errors',
          result.preview.errors,
          Array.isArray(result.preview.errors),
          '配列'
        );

        expect(
          'preview.version',
          result.preview.version,
          typeof result.preview.version === 'string' &&
            !!result.preview.version,
          '空でない文字列'
        );

        expect(
          'preview.date',
          result.preview.date,
          typeof result.preview.date === 'string' &&
            /^\d{4}-\d{2}-\d{2}$/.test(result.preview.date),
          '日付の文字列'
        );
      }
    }

    if (action === 'check') {
      expect(
        'checks',
        result.checks,
        Array.isArray(result.checks) &&
          result.checks.every(function (item) {
            return typeof item === 'string';
          }),
        '文字列の配列'
      );
    }

    if (issues.length) {
      throw receiveError(
        'read-extra-shape',
        '保存先の返答に、この画面の表示に必要な情報が含まれていません。',
        info,
        true,
        issues
      );
    }
  }

  function compareTasks(a, b) {
    const hourA = a.hour == null ? 7 : a.hour;
    const hourB = b.hour == null ? 7 : b.hour;

    if (hourA !== hourB) {
      return hourA - hourB;
    }

    const orderA = a.order == null ? Infinity : a.order;
    const orderB = b.order == null ? Infinity : b.order;

    return orderA - orderB || a.row - b.row;
  }

  function taskById(snapshot, id) {
    return snapshot
      ? snapshot.tasks.find(function (task) {
        return task.taskId === id;
      }) || null
      : null;
  }

  function dayVersion(snapshot, date) {
    return snapshot.days[date] || snapshot.emptyDay;
  }

  function mergePlan(items, tasks, date) {
    const available = tasks.filter(function (task) {
      return task.date === date && !task.localOnly;
    }).sort(compareTasks);

    const byId = new Map(
      available.map(function (task) {
        return [task.taskId, task];
      })
    );

    const used = new Set();
    const output = [];

    (items || []).forEach(function (item) {
      if (byId.has(item.id) && !used.has(item.id)) {
        used.add(item.id);

        output.push({
          id: item.id,
          hour: item.hour
        });
      }
    });

    available.forEach(function (task) {
      if (!used.has(task.taskId)) {
        output.push({
          id: task.taskId,
          hour: task.hour
        });
      }
    });

    return output.map(function (item, index) {
      return {
        item: item,
        index: index
      };
    }).sort(function (a, b) {
      const first = a.item.hour == null ? 7 : a.item.hour;
      const second = b.item.hour == null ? 7 : b.item.hour;

      return first - second || a.index - b.index;
    }).map(function (entry) {
      return entry.item;
    });
  }

  function resources(payload, snapshot) {
    const keys = [];

    if (
      payload.action === 'order' ||
      (payload.action === 'add' && payload.date)
    ) {
      keys.push('day:' + payload.date);
    }

    if (payload.taskId) {
      keys.push('task:' + payload.taskId);

      const task = taskById(snapshot, payload.taskId);

      if (task && task.date) {
        keys.push('day:' + task.date);
      }

      if (payload.action === 'edit' && payload.date) {
        keys.push('day:' + payload.date);
      }
    }

    if (
      payload.action.indexOf('periodic') === 0 ||
      payload.action === 'automatic'
    ) {
      keys.push('periodic');
    }

    if (payload.action === 'undo' || payload.action === 'done') {
      keys.push('undo');
    }

    return Array.from(new Set(keys));
  }

  function contextFor(payload, snapshot, jobs) {
    const keys = resources(payload, snapshot);

    return {
      keys: keys,
      causes: jobs.filter(function (job) {
        return (job.keys || []).some(function (key) {
          return keys.indexOf(key) >= 0;
        });
      }).map(function (job) {
        return job.id;
      })
    };
  }

  function advance(payload, transition) {
    if (!transition) {
      return;
    }

    (transition.days || []).forEach(function (entry) {
      if (
        payload.action === 'order' &&
        payload.date === entry.key &&
        payload.expectedDay === entry.before
      ) {
        payload.expectedDay = entry.after;
      }
    });

    (transition.tasks || []).forEach(function (entry) {
      if (
        payload.taskId === entry.key &&
        payload.expectedTask === entry.before
      ) {
        payload.expectedTask = entry.after;
      }
    });

    if (
      transition.periodic &&
      payload.expectedPeriodic === transition.periodic.before
    ) {
      payload.expectedPeriodic = transition.periodic.after;
    }

    if (
      transition.undo &&
      payload.expectedUndo === transition.undo.before
    ) {
      payload.expectedUndo = transition.undo.after;
    }
  }

  function relatedJobs(jobs, rootId) {
    const ids = new Set([rootId]);
    let changed = true;

    while (changed) {
      changed = false;

      jobs.forEach(function (job) {
        if (
          !ids.has(job.id) &&
          (job.causes || []).some(function (id) {
            return ids.has(id);
          })
        ) {
          ids.add(job.id);
          changed = true;
        }
      });
    }

    return jobs.filter(function (job) {
      return ids.has(job.id);
    }).sort(function (a, b) {
      return a.sequence - b.sequence;
    });
  }

  function readyJob(saved, force) {
    const ids = new Set(
      saved.jobs.map(function (job) {
        return job.id;
      })
    );

    const now = Date.now();

    return saved.jobs.slice().sort(function (a, b) {
      return a.sequence - b.sequence;
    }).find(function (job) {
      return ['saved', 'unknown', 'sending'].indexOf(job.state) >= 0 &&
        (force || !job.retryAt || job.retryAt <= now) &&
        !(job.causes || []).some(function (id) {
          return ids.has(id);
        });
    });
  }

  function applyAddLinks(saved, links) {
    if (!links) {
      return;
    }

    saved.jobs.forEach(function (job) {
      const link = links[job.id];

      if (
        job.payload.action === 'add' &&
        link &&
        typeof link.taskId === 'string'
      ) {
        job.remoteTaskId = link.taskId;
        job.remoteConfirmed = link.confirmed === true;
      }
    });
  }

  function storeSnapshot(saved, snapshot) {
    requireSnapshot(snapshot);
    applyAddLinks(saved, snapshot.addLinks);

    const oldTime = saved.snapshot
      ? Date.parse(saved.snapshot.fetchedAt || '')
      : NaN;

    const newTime = Date.parse(snapshot.fetchedAt || '');

    if (
      Number.isFinite(oldTime) &&
      Number.isFinite(newTime) &&
      newTime < oldTime
    ) {
      return;
    }

    saved.snapshot = snapshot;
  }

  function applyPatch(saved, patch) {
    if (
      !patch ||
      !Array.isArray(patch.tasks) ||
      !Array.isArray(patch.removed)
    ) {
      throw new Error('届いた変更内容を読み取れませんでした。');
    }

    if (
      saved.snapshot &&
      saved.snapshot.revision === patch.revision
    ) {
      applyAddLinks(saved, patch.addLinks);
      return true;
    }

    if (
      !saved.snapshot ||
      saved.snapshot.revision !== patch.baseRevision
    ) {
      return false;
    }

    const next = clone(saved.snapshot);

    const tasks = new Map(
      next.tasks.map(function (task) {
        return [task.taskId, task];
      })
    );

    patch.removed.forEach(function (id) {
      tasks.delete(id);
    });

    patch.tasks.forEach(function (task) {
      tasks.set(task.taskId, task);
    });

    next.tasks = Array.from(tasks.values()).sort(function (a, b) {
      return a.row - b.row;
    });

    [
      'app',
      'build',
      'features',
      'today',
      'fetchedAt',
      'revision',
      'days',
      'emptyDay'
    ].forEach(function (key) {
      next[key] = patch[key];
    });

    if (patch.periodic) {
      next.periodic = patch.periodic;
    }

    if (patch.undo) {
      next.undo = patch.undo;
    }

    next.addLinks = patch.addLinks || {};
    storeSnapshot(saved, next);
    return true;
  }

  async function oldPendingCount() {
    let fallback;

    try {
      fallback = JSON.parse(
        localStorage.getItem('outbox_v1') || '[]'
      );

      if (!Array.isArray(fallback)) {
        throw new Error('記録の形式が異なります。');
      }
    } catch (error) {
      throw new Error(
        '以前の未送信記録を読み取れません。端末データは消さないでください。'
      );
    }

    const old = await new Promise(function (resolve, reject) {
      const request = indexedDB.open('taskapp');
      let created = false;

      request.onupgradeneeded = function () {
        created = true;
        request.transaction.abort();
      };

      request.onerror = function () {
        if (created) {
          resolve([]);
        } else {
          reject(request.error);
        }
      };

      request.onsuccess = function () {
        const database = request.result;

        if (!database.objectStoreNames.contains('outbox')) {
          database.close();
          resolve([]);
          return;
        }

        const transaction = database.transaction('outbox', 'readonly');
        const get = transaction.objectStore('outbox').getAll();

        transaction.oncomplete = function () {
          database.close();
          resolve(get.result || []);
        };

        transaction.onerror = transaction.onabort = function () {
          database.close();
          reject(transaction.error);
        };
      };
    });

    return new Set(
      old.concat(fallback).map(function (job) {
        return job.id;
      })
    ).size;
  }

  class TaskClient {
    constructor(options) {
      this.options = options || {};
      this.id = uuid();
      this.db = null;
      this.channel = null;
      this.state = emptyState();
      this.ready = false;
      this.legacyCount = 0;
      this.paused = false;
      this.pumpPromise = null;
      this.localTail = Promise.resolve();
      this.controllers = new Set();
      this.lastReadError = '';
      this.lastCommunication = null;
      this.received = false;
      this.verifiedConnection = '';
      this.verifiedFeatures = {};
      this.legacyWaitUntil = 0;

      this.readStatus = {
        phase: 'idle',
        action: '',
        attempt: 0
      };

      this.readDiagnostics = [];
      this.diagnosticWarning = '';

      this.fastHandoff = !!(
        navigator.locks &&
        typeof navigator.locks.request === 'function'
      );
    }

    config() {
      return {
        url: localStorage.getItem(URL_KEY) || '',
        token: localStorage.getItem(TOKEN_KEY) || ''
      };
    }

    configured() {
      try {
        const value = this.config();
        return !!value.url && !!value.token;
      } catch (error) {
        return false;
      }
    }

    resetConnection() {
      this.verifiedConnection = '';
      this.verifiedFeatures = {};
    }

    emit(meta) {
      try {
        if (this.options.onChange) {
          this.options.onChange(meta || {
            kind: 'state'
          });
        }
      } catch (error) {
        console.error(error);
      }
    }

    issue(text, detail) {
      try {
        if (this.options.onIssue) {
          this.options.onIssue(text, detail || '');
        }
      } catch (error) {
        console.error(error);
      }
    }

    signal(meta) {
      this.emit(meta);

      try {
        if (this.channel) {
          this.channel.postMessage({
            type: 'changed',
            meta: meta || {
              kind: 'state'
            }
          });
        }
      } catch (error) {
        console.error(error);
      }
    }

    setReadStatus(phase, action, attempt) {
      this.readStatus = {
        phase: phase,
        action: safeAction(action),
        attempt: attempt || 0
      };

      this.emit({
        kind: 'read-state'
      });
    }

    readStatusLabel() {
      switch (this.readStatus.phase) {
        case 'reading':
          return '読み込み中';
        case 'retrying':
          return '一覧全体で再確認中';
        case 'success':
          return this.readStatus.attempt === 2
            ? '再確認で取得成功'
            : '取得成功';
        case 'failed':
          return '前回の取得に失敗';
        default:
          return 'この起動後は未確認';
      }
    }

    async start() {
      if (!window.indexedDB) {
        throw new Error('この端末では保存を利用できません。');
      }

      this.db = await new Promise(function (resolve, reject) {
        const request = indexedDB.open(DB_NAME, 1);

        request.onupgradeneeded = function () {
          if (!request.result.objectStoreNames.contains('data')) {
            request.result.createObjectStore('data');
          }
        };

        request.onsuccess = function () {
          resolve(request.result);
        };

        request.onerror = function () {
          reject(request.error);
        };

        request.onblocked = function () {
          reject(new Error(
            '別の画面が保存先を使用しています。タスク画面を開き直してください。'
          ));
        };
      });

      this.db.onversionchange = () => {
        this.ready = false;
        this.db.close();

        this.issue(
          '画面を開き直してください',
          '端末の保存先が変更されました。入力途中の内容は消さずに確認してください。'
        );

        this.emit();
      };

      this.state = await this.readState();
      this.legacyCount = await oldPendingCount();

      try {
        this.readDiagnostics = await this.readDiagnosticRecords();
      } catch (error) {
        this.diagnosticWarning = '以前の受信点検記録を読み取れませんでした。';
      }

      this.ready = true;

      if ('BroadcastChannel' in window) {
        this.channel = new BroadcastChannel(CHANNEL_NAME);

        this.channel.onmessage = async (event) => {
          if (this.paused) {
            return;
          }

          try {
            if (
              event.data &&
              event.data.type === 'read-diagnostics-changed'
            ) {
              this.readDiagnostics = await this.readDiagnosticRecords();

              this.emit({
                kind: 'diagnostic'
              });

              return;
            }

            this.state = await this.readState();

            const meta = event.data && event.data.meta
              ? event.data.meta
              : {
                kind: 'state'
              };

            this.emit(meta);
            this.pump(false);
          } catch (error) {
            this.issue(
              '端末の記録を読み取れません',
              String(error.message || error)
            );
          }
        };
      }

      window.addEventListener('online', () => {
        this.reloadLocal().then(() => {
          this.pump(true);
        }).catch((error) => {
          this.issue('端末の記録を読み取れません', error.message);
        });
      });

      window.addEventListener('offline', () => {
        this.emit({
          kind: 'status'
        });
      });

      window.addEventListener('storage', (event) => {
        if (
          event.key === URL_KEY ||
          event.key === TOKEN_KEY ||
          event.key === null
        ) {
          this.resetConnection();

          this.emit({
            kind: 'status'
          });

          this.pump(false);
        }
      });

      window.addEventListener('pagehide', () => {
        this.paused = true;

        this.controllers.forEach(function (controller) {
          controller.abort();
        });

        try {
          if (this.channel) {
            this.channel.postMessage({
              type: 'wake'
            });
          }
        } catch (error) {
          console.error(error);
        }
      });

      window.addEventListener('pageshow', (event) => {
        if (event.persisted) {
          this.paused = false;

          this.reloadLocal().then(() => {
            this.pump(false);
          }).catch((error) => {
            this.issue('端末の記録を読み取れません', error.message);
          });
        }
      });

      this.timer = setInterval(() => {
        if (
          !this.paused &&
          this.ready &&
          (
            !this.channel ||
            this.state.jobs.length
          )
        ) {
          this.reloadLocal().then(() => {
            this.pump(false);
          }).catch((error) => {
            this.issue('端末の記録を読み取れません', error.message);
          });
        }
      }, 2000);

      this.emit({
        kind: 'ready'
      });

      if (this.legacyCount) {
        this.issue(
          '旧画面の未送信があります',
          '以前の画面に未送信が ' + this.legacyCount +
          '件残っています。記録は消していません。'
        );
      }

      return this;
    }

    readState() {
      return new Promise((resolve, reject) => {
        const transaction = this.db.transaction('data', 'readonly');
        const request = transaction.objectStore('data').get('main');

        transaction.oncomplete = function () {
          try {
            resolve(checkedState(request.result));
          } catch (error) {
            reject(error);
          }
        };

        transaction.onerror = transaction.onabort = function () {
          reject(
            transaction.error ||
            new Error('端末の記録を読み取れませんでした。')
          );
        };
      });
    }

    async reloadLocal() {
      if (!this.ready || this.paused) {
        return;
      }

      const saved = await this.readState();
      const changed = saved.savedAt !== this.state.savedAt;
      this.state = saved;

      if (changed) {
        this.emit({
          kind: 'state'
        });
      }
    }

    mutate(change) {
      return new Promise((resolve, reject) => {
        const transaction = this.db.transaction('data', 'readwrite');
        const store = transaction.objectStore('data');
        const request = store.get('main');

        let next;
        let output;
        let caught;

        request.onsuccess = function () {
          try {
            next = checkedState(request.result);
            output = change(next);
            next.savedAt = Date.now();
            store.put(next, 'main');
          } catch (error) {
            caught = error;
            transaction.abort();
          }
        };

        transaction.oncomplete = () => {
          this.state = next;
          resolve(output);

          this.signal({
            kind: 'state'
          });
        };

        transaction.onerror = transaction.onabort = function () {
          reject(
            caught ||
            transaction.error ||
            new Error('端末に保存できませんでした。')
          );
        };
      });
    }

    readDiagnosticRecords() {
      return new Promise((resolve, reject) => {
        const transaction = this.db.transaction('data', 'readonly');
        const request = transaction.objectStore('data').get(DIAGNOSTIC_KEY);

        transaction.oncomplete = function () {
          const records = request.result;

          resolve(
            Array.isArray(records)
              ? records.slice(-DIAGNOSTIC_LIMIT)
              : []
          );
        };

        transaction.onerror = transaction.onabort = function () {
          reject(transaction.error || new Error('点検記録を読み取れませんでした。'));
        };
      });
    }

    async saveReadDiagnostic(record) {
      const safeRecord = clone(record);

      try {
        const records = await new Promise((resolve, reject) => {
          const transaction = this.db.transaction('data', 'readwrite');
          const store = transaction.objectStore('data');
          const request = store.get(DIAGNOSTIC_KEY);
          let next;

          request.onsuccess = function () {
            const previous = Array.isArray(request.result)
              ? request.result
              : [];

            next = previous.filter(function (entry) {
              return entry.id !== safeRecord.id;
            });

            next.push(safeRecord);
            next = next.slice(-DIAGNOSTIC_LIMIT);
            store.put(next, DIAGNOSTIC_KEY);
          };

          transaction.oncomplete = function () {
            resolve(next);
          };

          transaction.onerror = transaction.onabort = function () {
            reject(transaction.error || new Error('点検記録を保存できませんでした。'));
          };
        });

        this.readDiagnostics = records;
        this.diagnosticWarning = '';

        if (this.channel) {
          this.channel.postMessage({
            type: 'read-diagnostics-changed'
          });
        }
      } catch (error) {
        this.readDiagnostics = this.readDiagnostics.filter(function (entry) {
          return entry.id !== safeRecord.id;
        });

        this.readDiagnostics.push(safeRecord);
        this.readDiagnostics = this.readDiagnostics.slice(-DIAGNOSTIC_LIMIT);
        this.diagnosticWarning =
          '受信点検を端末に保存できませんでした。この画面を閉じると記録が失われる場合があります。';
      }

      this.emit({
        kind: 'diagnostic'
      });
    }

    readDiagnosticText() {
      const records = this.readDiagnostics.slice().reverse();
      const actionNames = {
        load: '一覧取得',
        history: '完了済み取得',
        preview: '定期タスクの対象確認',
        check: '動作の点検'
      };

      const outcomeNames = {
        retrying: '再確認中',
        recovered: '再確認で取得成功',
        failed: '取得失敗'
      };

      const codeNames = {
        'non-json': 'JSONではない返答',
        'response-envelope': '返答全体の形式不一致',
        'server-version': '保存先の版の不一致',
        'snapshot-shape': 'タスク一覧の形式不一致',
        'unchanged-shape': '変更なしの返答の形式不一致',
        'read-extra-shape': '画面別情報の形式不一致',
        'cached-list-mismatch': '端末の一覧と変更なしの返答を照合できない',
        'server-rejection': '保存先が要求を受け付けなかった',
        'http': '通信の応答番号が正常ではない',
        'network': '接続失敗',
        'timeout': '応答待ち時間超過',
        'interrupted': '通信中断',
        'other': '取得または端末保存の処理で失敗'
      };

      const lines = [
        '受信点検の版：' + BUILD
      ];

      if (this.diagnosticWarning) {
        lines.push(this.diagnosticWarning);
      }

      if (!records.length) {
        lines.push('異常な返答の記録：なし');
        return lines.join('\n');
      }

      records.forEach(function (record, index) {
        const time = Date.parse(record.at || '');
        const label = Number.isFinite(time)
          ? new Date(time + 9 * 3600000)
            .toISOString()
            .slice(0, 19)
            .replace('T', ' ')
          : '日時不明';

        lines.push(
          '',
          '【' + (index + 1) + '】' + label + '（日本時間）',
          '操作：' + (actionNames[record.action] || 'その他'),
          '結果：' + (outcomeNames[record.outcome] || '未確定')
        );

        record.attempts.forEach(function (attempt) {
          const info = attempt.response || {};

          lines.push(
            '・' + attempt.number + '回目' +
              '／全体取得要求：' + (attempt.full ? 'あり' : 'なし') +
              '／' + (attempt.accepted ? '受理' : '不受理'),
            '  判定：' + (
              attempt.accepted
                ? '必要な情報を確認'
                : codeNames[attempt.code] || 'その他'
            ),
            '  返答種別：' + (info.format || '未確認'),
            '  応答番号：' + (
              info.httpStatus == null ? '未取得' : info.httpStatus
            ),
            '  Content-Type：' + (info.contentType || 'なし'),
            '  ok：' + (
              info.ok === null || info.ok === undefined
                ? 'なし'
                : String(info.ok)
            ),
            '  status：' + (info.status || 'なし'),
            '  app：' + (info.app || 'なし'),
            '  build：' + (info.build || 'なし'),
            '  unchanged：' + String(info.unchanged === true)
          );

          if (Number.isInteger(info.taskCount)) {
            lines.push('  返答内のタスク件数：' + info.taskCount);
          }

          (attempt.issues || []).forEach(function (issue) {
            lines.push(
              '  不足・不一致：' + issue.field +
              '／期待=' + issue.expected +
              '／受信=' + issue.actual
            );
          });

          if (!attempt.accepted) {
            (info.fields || []).forEach(function (field) {
              lines.push('  ' + field.name + '：' + field.type);
            });
          }
        });
      });

      return lines.join('\n');
    }

    senderRecord(action, webLock) {
      return new Promise((resolve, reject) => {
        const transaction = this.db.transaction('data', 'readwrite');
        const store = transaction.objectStore('data');
        const request = store.get('sender');

        let result = {
          ok: false,
          until: 0
        };

        request.onsuccess = () => {
          const saved = request.result;
          const now = Date.now();

          if (action === 'release') {
            if (saved && saved.owner === this.id) {
              store.delete('sender');
            }

            result.ok = true;
            return;
          }

          if (action === 'renew') {
            if (saved && saved.owner === this.id) {
              saved.until = now + 180000;
              store.put(saved, 'sender');
              result.ok = true;
            }

            return;
          }

          const protectedOldOwner =
            saved &&
            saved.owner !== this.id &&
            saved.until > now &&
            !(webLock && saved.method === 'web-lock-v1');

          if (protectedOldOwner) {
            result.until = saved.until;
            return;
          }

          store.put({
            owner: this.id,
            until: now + 180000,
            method: webLock ? 'web-lock-v1' : 'lease-v1'
          }, 'sender');

          result.ok = true;
        };

        transaction.oncomplete = function () {
          resolve(result);
        };

        transaction.onerror = transaction.onabort = function () {
          reject(
            transaction.error ||
            new Error('送信担当を確認できませんでした。')
          );
        };
      });
    }

    async withNetwork(work, options) {
      const settings = options || {};

      const run = async () => {
        if (this.paused) {
          return SKIPPED;
        }

        let owned = false;
        let renewal = null;

        if (settings.write) {
          const claim = await this.senderRecord('claim', this.fastHandoff);

          if (!claim.ok) {
            this.legacyWaitUntil = claim.until;

            this.emit({
              kind: 'status'
            });

            return SKIPPED;
          }

          this.legacyWaitUntil = 0;
          owned = true;

          renewal = setInterval(() => {
            this.senderRecord('renew', this.fastHandoff)
              .catch(function () {
                // 次の操作前にも所有状態を確認する。
              });
          }, 10000);
        }

        try {
          return await work();
        } finally {
          if (renewal) {
            clearInterval(renewal);
          }

          if (owned) {
            await this.senderRecord('release', this.fastHandoff)
              .catch(function () {
                return null;
              });
          }
        }
      };

      if (this.fastHandoff) {
        const controller = new AbortController();
        this.controllers.add(controller);

        const lockOptions = {
          mode: 'exclusive',
          signal: controller.signal
        };

        if (settings.opportunistic) {
          lockOptions.ifAvailable = true;
          delete lockOptions.signal;
        }

        try {
          return await navigator.locks.request(
            NETWORK_LOCK,
            lockOptions,
            async function (lock) {
              return lock ? run() : SKIPPED;
            }
          );
        } finally {
          this.controllers.delete(controller);
        }
      }

      const result = this.localTail.then(run);

      this.localTail = result.catch(function () {
        return undefined;
      });

      return result;
    }

    clientHint(forceFull) {
      return {
        protocol: SYNC_PROTOCOL,
        forceFull: !!forceFull,
        revision: this.state.snapshot
          ? this.state.snapshot.revision || ''
          : '',
        pendingAdds: this.state.jobs.filter(function (job) {
          return job.payload.action === 'add';
        }).slice(0, 500).map(function (job) {
          return job.id;
        })
      };
    }

    async request(payload, forceFull) {
      if (!this.configured()) {
        throw new Error('接続先と合い言葉を設定してください。');
      }

      if (!navigator.onLine) {
        throw receiveError(
          'network',
          '通信がありません。',
          summarizeResponse(undefined, {
            format: '返答なし'
          }),
          false
        );
      }

      const config = this.config();
      const controller = new AbortController();
      const started = performance.now();
      let timedOut = false;

      let transport = {
        format: '返答なし',
        httpStatus: null,
        contentType: 'なし'
      };

      this.controllers.add(controller);

      const timer = setTimeout(function () {
        timedOut = true;
        controller.abort();
      }, REQUEST_TIMEOUT_MS);

      try {
        const response = await fetch(config.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'text/plain;charset=utf-8'
          },
          body: JSON.stringify(Object.assign({
            mode: 'web',
            token: config.token
          }, payload, {
            clientState: this.clientHint(forceFull)
          })),
          redirect: 'follow',
          signal: controller.signal
        });

        transport = {
          format: '本文読取前',
          httpStatus: response.status,
          contentType: safeContentType(response.headers.get('Content-Type'))
        };

        if (!response.ok) {
          const error = receiveError(
            'http',
            '保存先から正常な返答を受け取れませんでした' +
              '（応答番号：' + response.status + '）。',
            summarizeResponse(undefined, transport),
            false
          );

          error.httpStatus = response.status;
          throw error;
        }

        const text = await response.text();
        let result;

        try {
          result = JSON.parse(text);
        } catch (error) {
          transport.format = !text.trim()
            ? '空の返答'
            : /^\s*</.test(text)
              ? 'HTML形式'
              : 'JSON以外の文字列';

          throw receiveError(
            'non-json',
            '保存先の返答をタスクデータとして読み取れませんでした。',
            summarizeResponse(undefined, transport),
            true
          );
        }

        transport.format = 'JSON';
        const info = summarizeResponse(result, transport);

        if (
          !isObject(result) ||
          typeof result.ok !== 'boolean'
        ) {
          throw receiveError(
            'response-envelope',
            '保存先の返答の形式を確認できませんでした。',
            info,
            true,
            [{
              field: 'ok',
              expected: '真偽値',
              actual: isObject(result)
                ? valueType(result.ok)
                : '返答全体が項目の組ではない'
            }]
          );
        }

        if (result.ok && result.app !== SERVER_VERSION) {
          this.resetConnection();

          throw receiveError(
            'server-version',
            'この画面に対応する保存先ではありません。',
            info,
            false
          );
        }

        if (result.ok) {
          const source = result.snapshot || result.patch || result;
          this.verifiedConnection = config.url + '\n' + config.token;
          this.verifiedFeatures = source.features || this.verifiedFeatures;
        }

        Object.defineProperty(result, RESPONSE_INFO, {
          value: info,
          enumerable: false
        });

        this.lastCommunication = {
          action: payload.action,
          milliseconds: Math.round(performance.now() - started),
          serverMs: Number.isFinite(result.serverMs)
            ? result.serverMs
            : null
        };

        return result;
      } catch (error) {
        if (this.paused) {
          throw error;
        }

        if (timedOut) {
          throw receiveError(
            'timeout',
            '保存先の応答を60秒以内に受け取れませんでした。',
            summarizeResponse(undefined, transport),
            false
          );
        }

        if (error && error.receiveCode) {
          throw error;
        }

        if (error && error.name === 'AbortError') {
          throw receiveError(
            'interrupted',
            '通信が途中で中断されました。',
            summarizeResponse(undefined, transport),
            false
          );
        }

        if (error && error.name === 'TypeError') {
          throw receiveError(
            'network',
            '保存先に接続できませんでした。',
            summarizeResponse(undefined, transport),
            false
          );
        }

        throw error;
      } finally {
        clearTimeout(timer);
        this.controllers.delete(controller);
      }
    }

    markReceived(clearReadError) {
      if (clearReadError === true) {
        this.lastReadError = '';
      }

      this.received = true;

      this.emit({
        kind: 'status'
      });
    }

    async acceptRead(result) {
      if (result.unchanged) {
        return this.mutate(function (saved) {
          if (
            !saved.snapshot ||
            saved.snapshot.revision !== result.revision ||
            snapshotIssues(saved.snapshot).length
          ) {
            return false;
          }

          applyAddLinks(saved, result.addLinks);

          const oldTime = Date.parse(saved.snapshot.fetchedAt || '');
          const newTime = Date.parse(result.fetchedAt || '');

          if (!Number.isFinite(oldTime) || newTime >= oldTime) {
            saved.snapshot.fetchedAt = result.fetchedAt;
          }

          if (result.features) {
            saved.snapshot.features = result.features;
          }

          if (result.build) {
            saved.snapshot.build = result.build;
          }

          saved.lastNetworkAt = Date.now();
          return true;
        });
      }

      requireSnapshot(
        result.snapshot,
        result[RESPONSE_INFO]
      );

      await this.mutate(function (saved) {
        storeSnapshot(saved, result.snapshot);
        saved.lastNetworkAt = Date.now();
      });

      return true;
    }

    async performRead(payload, settings) {
      let full = !!settings.forceFull;
      let diagnostic = null;

      for (let attempt = 1; attempt <= 2; attempt++) {
        let response = null;

        this.setReadStatus(
          attempt === 1 ? 'reading' : 'retrying',
          payload.action,
          attempt
        );

        try {
          response = await this.request(payload, full);
          validateReadResponse(payload.action, response, full);

          const accepted = await this.acceptRead(response);

          if (!accepted) {
            throw receiveError(
              'cached-list-mismatch',
              '端末の一覧と、保存先の「変更なし」という返答を照合できませんでした。',
              response[RESPONSE_INFO],
              true,
              [{
                field: 'local.snapshot',
                expected: '返答の版と一致する有効な一覧',
                actual: '照合できない'
              }]
            );
          }

          if (diagnostic) {
            diagnostic.attempts.push({
              number: attempt,
              full: full,
              accepted: true,
              code: '',
              response: response[RESPONSE_INFO] ||
                summarizeResponse(response),
              issues: []
            });

            diagnostic.outcome = 'recovered';
            await this.saveReadDiagnostic(diagnostic);
          }

          this.markReceived(true);
          this.setReadStatus('success', payload.action, attempt);
          return response;
        } catch (error) {
          if (this.paused) {
            throw error;
          }

          if (!diagnostic) {
            diagnostic = {
              id: uuid(),
              at: new Date().toISOString(),
              action: safeAction(payload.action),
              outcome: 'failed',
              attempts: []
            };
          }

          diagnostic.attempts.push({
            number: attempt,
            full: full,
            accepted: false,
            code: error.receiveCode || 'other',
            response: error.receiveInfo ||
              (
                response
                  ? response[RESPONSE_INFO] || summarizeResponse(response)
                  : summarizeResponse(undefined, {
                    format: '返答を確認できない'
                  })
              ),
            issues: error.receiveIssues || []
          });

          if (attempt === 1 && error.retryFull === true) {
            diagnostic.outcome = 'retrying';
            await this.saveReadDiagnostic(diagnostic);
            full = true;
            continue;
          }

          diagnostic.outcome = 'failed';
          await this.saveReadDiagnostic(diagnostic);

          const message = attempt === 2
            ? '一覧全体で再確認しましたが、取得できませんでした。\n' +
              String(error.message || error)
            : String(error.message || error);

          this.lastReadError = message;
          this.setReadStatus('failed', payload.action, attempt);
          throw new Error(message);
        }
      }

      throw new Error('一覧を取得できませんでした。');
    }

    async read(payload, options) {
      const settings = options || {};

      if (!this.ready || this.legacyCount) {
        throw new Error('端末保存の準備ができていません。');
      }

      if (READ_ACTIONS.indexOf(payload.action) < 0) {
        throw new Error('読み取り用の操作ではありません。');
      }

      try {
        const result = await this.withNetwork(async () => {
          this.state = await this.readState();

          if (
            settings.background &&
            Date.now() - (this.state.lastNetworkAt || 0) < 20000
          ) {
            return SKIPPED;
          }

          // 自動再確認は読み取り要求だけ。更新操作は再実行しない。
          return this.performRead(payload, settings);
        }, {
          opportunistic: !!settings.background
        });

        return result === SKIPPED ? null : result;
      } catch (error) {
        if (!this.paused) {
          this.lastReadError = String(error.message || error);

          if (this.readStatus.phase !== 'failed') {
            this.setReadStatus('failed', payload.action, 0);
          }
        }

        throw error;
      }
    }

    context(payload, snapshot) {
      return contextFor(
        payload,
        snapshot || this.state.snapshot,
        this.state.jobs
      );
    }

    async enqueue(payload, label, captured) {
      if (!this.ready || this.legacyCount) {
        throw new Error('端末保存の準備ができていません。');
      }

      const id = uuid();

      await this.mutate(function (saved) {
        const current = contextFor(payload, saved.snapshot, saved.jobs);

        const context = captured
          ? {
            keys: Array.from(new Set(
              captured.keys.concat(current.keys)
            )),
            causes: Array.from(new Set(
              captured.causes.concat(current.causes)
            ))
          }
          : current;

        const data = clone(payload);
        data.requestId = id;

        saved.transitions.forEach(function (entry) {
          if (context.causes.indexOf(entry.id) >= 0) {
            advance(data, entry.transition);
          }
        });

        saved.sequence++;

        saved.jobs.push({
          id: id,
          sequence: saved.sequence,
          payload: data,
          label: label,
          keys: context.keys,
          causes: context.causes,
          state: 'saved',
          frozen: false,
          note: '',
          createdAt: Date.now(),
          retryAt: 0,
          attempts: 0
        });
      });

      this.pump(false);
      return id;
    }

    async acceptMutation(job, result, timing) {
      if (result.snapshot) {
        requireSnapshot(result.snapshot);
      } else if (!result.patch) {
        throw new Error('保存結果に必要な一覧情報がありません。');
      }

      return this.mutate(function (saved) {
        if (result.snapshot) {
          storeSnapshot(saved, result.snapshot);
        } else if (!applyPatch(saved, result.patch)) {
          return false;
        }

        const exists = saved.jobs.some(function (entry) {
          return entry.id === job.id;
        });

        if (exists) {
          saved.jobs.forEach(function (entry) {
            if (
              entry.id !== job.id &&
              !entry.frozen &&
              (entry.causes || []).indexOf(job.id) >= 0
            ) {
              advance(entry.payload, result.transition);
            }
          });

          saved.jobs = saved.jobs.filter(function (entry) {
            return entry.id !== job.id;
          });

          saved.transitions.push({
            id: job.id,
            transition: result.transition
          });

          saved.transitions = saved.transitions.slice(-100);
        }

        saved.lastNetworkAt = Date.now();

        saved.lastSend = {
          action: job.payload.action,
          at: new Date().toISOString(),
          waitMs: job.createdAt && job.firstSentAt
            ? Math.max(0, job.firstSentAt - job.createdAt)
            : null,
          roundTripMs: timing,
          serverMs: Number.isFinite(result.serverMs)
            ? result.serverMs
            : null,
          ok: true
        };

        return true;
      });
    }

    async sendOne(force) {
      let job = null;

      await this.mutate(function (saved) {
        const current = readyJob(saved, force);

        if (!current) {
          return;
        }

        if (
          !current.frozen &&
          current.payload.action === 'order' &&
          saved.snapshot
        ) {
          current.payload.items = mergePlan(
            current.payload.items,
            saved.snapshot.tasks,
            current.payload.date
          );
        }

        current.frozen = true;
        current.state = 'sending';
        current.note = '';
        current.retryAt = 0;
        current.firstSentAt = current.firstSentAt || Date.now();
        current.lastAttemptAt = Date.now();
        job = clone(current);
      });

      if (!job) {
        return {
          stop: true
        };
      }

      const started = performance.now();

      try {
        const config = this.config();
        const connection = config.url + '\n' + config.token;

        if (
          job.payload.action === 'periodicSave' &&
          Object.prototype.hasOwnProperty.call(job.payload, 'dueRule') &&
          this.verifiedConnection !== connection
        ) {
          const checked = await this.request({
            action: 'load'
          }, true);

          if (!checked.ok) {
            throw new Error(checked.message || '保存先を確認できませんでした。');
          }

          if (
            !checked.snapshot ||
            !checked.snapshot.features ||
            !checked.snapshot.features.periodicDue
          ) {
            throw new Error('保存先が期限設定に対応していません。');
          }

          await this.acceptRead(checked);
        }

        const result = await this.request(job.payload, false);

        if (result.ok) {
          const timing = Math.round(performance.now() - started);
          let accepted = await this.acceptMutation(job, result, timing);

          if (!accepted) {
            const full = await this.request({
              action: 'load'
            }, true);

            if (!full.ok) {
              throw new Error(full.message || '保存後の一覧を確認できませんでした。');
            }

            requireSnapshot(full.snapshot);
            result.snapshot = full.snapshot;
            delete result.patch;

            accepted = await this.acceptMutation(job, result, timing);
          }

          if (!accepted) {
            throw new Error('保存後の一覧を確認できませんでした。');
          }

          // 更新の成功だけで、直前の一覧取得エラーを消さない。
          this.markReceived(false);

          this.signal({
            kind: 'committed',
            action: job.payload.action
          });

          try {
            if (this.options.onSaved) {
              this.options.onSaved(job, result);
            }
          } catch (error) {
            console.error(error);
          }

          return {
            saved: true,
            stop: false
          };
        }

        const conflict = result.status === 'conflict';
        const blocked = result.status === 'invalid' ||
          result.status === 'indeterminate';

        if (conflict || blocked) {
          await this.mutate(function (saved) {
            const current = saved.jobs.find(function (entry) {
              return entry.id === job.id;
            });

            if (current) {
              current.state = conflict ? 'conflict' : 'blocked';
              current.note = result.message || '確認が必要です。';
              current.retryAt = 0;
            }

            if (result.snapshot) {
              storeSnapshot(saved, result.snapshot);
              saved.lastNetworkAt = Date.now();
            }
          });

          return {
            saved: false,
            stop: false
          };
        }

        throw new Error(result.message || '送信を確認できませんでした。');
      } catch (error) {
        if (this.paused) {
          throw error;
        }

        await this.mutate(function (saved) {
          const current = saved.jobs.find(function (entry) {
            return entry.id === job.id;
          });

          if (
            !current ||
            current.state === 'conflict' ||
            current.state === 'blocked'
          ) {
            return;
          }

          current.attempts = (current.attempts || 0) + 1;

          const delay = Math.min(
            300000,
            5000 * Math.pow(2, Math.min(current.attempts - 1, 6))
          );

          current.state = 'unknown';
          current.retryAt = Date.now() + delay;
          current.note =
            String(error.message || error) +
            '\n未反映とは限りません。同じ受付番号で再確認します。';
        });

        return {
          saved: false,
          stop: true
        };
      }
    }

    pump(force) {
      if (this.pumpPromise) {
        return this.pumpPromise;
      }

      if (
        !this.ready ||
        this.legacyCount ||
        this.paused ||
        !navigator.onLine ||
        !this.configured() ||
        !readyJob(this.state, !!force)
      ) {
        return Promise.resolve(false);
      }

      this.pumpPromise = (async () => {
        let changed = false;
        let allowForce = !!force;

        while (
          this.ready &&
          !this.paused &&
          navigator.onLine &&
          this.configured()
        ) {
          this.state = await this.readState();

          if (!readyJob(this.state, allowForce)) {
            break;
          }

          const result = await this.withNetwork(
            () => this.sendOne(allowForce),
            {
              write: true
            }
          );

          allowForce = false;

          if (result === SKIPPED) {
            break;
          }

          if (result.saved) {
            changed = true;
          }

          if (result.stop) {
            break;
          }
        }

        return changed;
      })().catch((error) => {
        if (!this.paused) {
          this.issue(
            '端末の保存を確認できません',
            String(error.message || error) +
            '\nデータは消さずに、画面を開き直してください。'
          );
        }

        return false;
      }).finally(() => {
        this.pumpPromise = null;

        this.emit({
          kind: 'status'
        });
      });

      return this.pumpPromise;
    }

    effectiveTasks() {
      let tasks = this.state.snapshot
        ? clone(this.state.snapshot.tasks)
        : [];

      const links = this.state.snapshot
        ? this.state.snapshot.addLinks || {}
        : {};

      this.state.jobs.slice().sort(function (a, b) {
        return a.sequence - b.sequence;
      }).forEach(function (job) {
        const payload = job.payload;

        if (payload.action === 'add') {
          const link = links[job.id] || {};
          const remoteId = job.remoteTaskId || link.taskId || '';
          const confirmed =
            job.remoteConfirmed === true ||
            link.confirmed === true;

          const visible = remoteId && tasks.some(function (task) {
            return task.taskId === remoteId;
          });

          if (!visible && !confirmed) {
            tasks.push({
              taskId: 'local:' + job.id,
              title: payload.title,
              due: payload.due || '',
              date: payload.date || '',
              hour: null,
              order: null,
              row: 1000000000 + job.sequence,
              localOnly: true,
              pendingText:
                job.state === 'conflict' || job.state === 'blocked'
                  ? '確認が必要'
                  : job.state === 'sending' || job.state === 'unknown'
                    ? '送信結果を確認中'
                    : '送信待ち'
            });
          }
        }

        if (payload.action === 'done') {
          tasks = tasks.filter(function (task) {
            return task.taskId !== payload.taskId;
          });
        }

        if (payload.action === 'edit') {
          const task = tasks.find(function (entry) {
            return entry.taskId === payload.taskId;
          });

          if (task) {
            task.title = payload.title;
            task.due = payload.due;
            task.date = payload.date;
          }
        }

        if (payload.action === 'order') {
          mergePlan(payload.items, tasks, payload.date)
            .forEach(function (item, index) {
              const task = tasks.find(function (entry) {
                return entry.taskId === item.id;
              });

              if (task) {
                task.hour = item.hour;
                task.order = index + 1;
              }
            });
        }
      });

      return tasks;
    }

    relatedJobs(id) {
      return relatedJobs(this.state.jobs, id);
    }

    async resolveConflict(id, useLocal, reviewedIds) {
      await this.mutate(function (saved) {
        const root = saved.jobs.find(function (job) {
          return job.id === id && job.state === 'conflict';
        });

        if (!root) {
          return;
        }

        const related = relatedJobs(saved.jobs, id);

        const actual = related.map(function (job) {
          return job.id;
        }).sort();

        const reviewed = (reviewedIds || []).slice().sort();

        if (JSON.stringify(actual) !== JSON.stringify(reviewed)) {
          throw new Error(
            '確認中に関連する操作が増えました。確認画面を開き直してください。'
          );
        }

        if (related.some(function (job) {
          return job.id !== id && job.frozen;
        })) {
          throw new Error(
            '関連する送信結果を確認中です。少し待って開き直してください。'
          );
        }

        const ids = new Set(actual);

        if (!useLocal) {
          saved.jobs = saved.jobs.filter(function (job) {
            return !ids.has(job.id);
          });
          return;
        }

        const replacements = new Map();

        related.forEach(function (job) {
          replacements.set(job.id, uuid());
        });

        saved.jobs.forEach(function (job) {
          if (!ids.has(job.id)) {
            return;
          }

          const payload = job.payload;
          const newId = replacements.get(job.id);

          job.id = newId;
          payload.requestId = newId;
          job.frozen = false;
          job.state = 'saved';
          job.note = '';
          job.retryAt = 0;
          job.attempts = 0;
          job.createdAt = Date.now();
          delete job.firstSentAt;
          delete job.lastAttemptAt;

          job.causes = (job.causes || []).map(function (cause) {
            return replacements.get(cause) || cause;
          });

          if (payload.action === 'order') {
            payload.expectedDay = dayVersion(saved.snapshot, payload.date);
            payload.items = mergePlan(
              payload.items,
              saved.snapshot.tasks,
              payload.date
            );
          }

          if (payload.taskId) {
            const task = taskById(saved.snapshot, payload.taskId);
            payload.expectedTask = task ? task.version : '';
          }

          if (payload.expectedPeriodic) {
            payload.expectedPeriodic = saved.snapshot.periodic.version;
          }

          if (payload.expectedUndo) {
            payload.expectedUndo = saved.snapshot.undo.version;
          }
        });
      });

      this.pump(false);
    }
  }

  window.TaskCore = {
    VERSION: VERSION,
    BUILD: BUILD,
    create: function (options) {
      return new TaskClient(options);
    },
    emptyState: emptyState,
    clone: clone,
    compareTasks: compareTasks,
    taskById: taskById,
    dayVersion: dayVersion,
    mergePlan: mergePlan
  };
})();
