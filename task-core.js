// File: task-core.js
(function () {
  'use strict';

  const VERSION = 'v4.8';
  const BUILD = 'v4.11.3';
  const SERVER_VERSION = 'v4.3';
  const SYNC_PROTOCOL = 'task-sync-v1';
  const TRACE_PROTOCOL = 'task-read-trace-v1';
  const EDIT_PROTOCOL = 'task-edit-fields-v1';

  const DB_NAME = 'taskapp-unified';
  const URL_KEY = 'gasUrl_v1';
  const TOKEN_KEY = 'gasTok_v1';
  const CHANNEL_NAME = 'task-unified-state';
  const NETWORK_LOCK = 'taskapp-unified-remote-v1';

  const REQUEST_TIMEOUT_MS = 60000;
  const READ_RETRY_DELAY_MS = 2000;
  const RESUME_REQUEST_AGE_MS = 30000;
  const RESUME_HIDDEN_TIME_MS = 15000;

  const DIAGNOSTIC_KEY = 'read-receipt-checks-v1';
  const TRACE_KEY = 'read-traces-v1';
  const DIAGNOSTIC_LIMIT = 12;

  const RESPONSE_INFO = Symbol('response-info');
  const SKIPPED = Symbol('skipped');

  const READ_ACTIONS = [
    'load',
    'history',
    'preview',
    'check'
  ];

  const MUTATION_ACTIONS = [
    'add',
    'order',
    'edit',
    'done',
    'undo',
    'periodicSave',
    'periodicSend',
    'periodicRun',
    'automatic'
  ];

  const EDIT_FIELDS = [
    'title',
    'due',
    'date'
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
    return READ_ACTIONS.concat(MUTATION_ACTIONS).indexOf(value) >= 0
      ? value
      : 'その他';
  }

  function actionLabel(value) {
    const names = {
      load: '一覧更新',
      history: '完了済み更新',
      preview: '定期タスクの対象確認',
      check: '動作確認',
      add: '追加',
      order: '配置',
      edit: '編集',
      done: '完了',
      undo: '取り消し',
      periodicSave: '定期設定',
      periodicSend: '定期追加',
      periodicRun: '今日の定期追加',
      automatic: '自動追加設定'
    };

    return names[value] || 'その他';
  }

  function finalDestination(finalUrl, initialUrl) {
    if (!finalUrl) {
      return '確認できない';
    }

    try {
      const final = new URL(finalUrl);
      const initial = new URL(initialUrl);

      if (
        final.origin === initial.origin &&
        final.pathname.replace(/\/+$/, '') ===
          initial.pathname.replace(/\/+$/, '')
      ) {
        return '元の公開先';
      }

      if (final.hostname === 'script.googleusercontent.com') {
        return 'Googleの結果受け取り先';
      }

      return 'その他';
    } catch (error) {
      return '確認できない';
    }
  }

  function isEntryGuide(value) {
    if (!isObject(value)) {
      return false;
    }

    const keys = Object.keys(value);
    const expected = ['ok', 'app', 'build', 'message'];

    return keys.length === expected.length &&
      keys.every(function (key) {
        return expected.indexOf(key) >= 0;
      }) &&
      value.ok === true &&
      value.app === SERVER_VERSION &&
      typeof value.build === 'string' &&
      safeVersion(value.build) !== '指定外' &&
      value.message === '個人用タスク管理';
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
      redirected: typeof info.redirected === 'boolean'
        ? info.redirected
        : null,
      finalDestination: info.finalDestination || '確認できない',
      entryGuide: isObject(result) ? isEntryGuide(result) : null,
      rootType: valueType(result),
      ok: typeof source.ok === 'boolean' ? source.ok : null,
      status: safeStatus(source.status),
      app: safeVersion(source.app),
      build: safeVersion(source.build || snapshot.build),
      unchanged: source.unchanged === true,
      elapsedMs: Number.isFinite(info.elapsedMs)
        ? info.elapsedMs
        : null,
      traceEcho: info.traceEcho || '対象外',
      serverMs: Number.isFinite(source.serverMs)
        ? source.serverMs
        : null,
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

  function receiveError(
    code,
    message,
    info,
    retryFull,
    issues,
    retryAfterMs
  ) {
    const error = new Error(message);
    error.receiveCode = code;
    error.receiveInfo = info || null;
    error.retryFull = retryFull === true;
    error.receiveIssues = issues || [];
    error.retryAfterMs = Number.isFinite(retryAfterMs)
      ? Math.max(0, retryAfterMs)
      : 0;

    return error;
  }

  function interruptedRead() {
    const error = new Error('古い一覧更新を終了しました。');
    error.supersededRead = true;
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

    expect('snapshot', snapshot, isObject(snapshot), '項目の組');

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
      const error = receiveError(
        'server-rejection',
        String(result.message || '一覧を更新できませんでした。'),
        info,
        false
      );

      error.serverStatus = safeStatus(result.status);
      throw error;
    }

    if (isEntryGuide(result)) {
      throw receiveError(
        'entry-guide',
        '一覧ではなく、保存先の入口の案内が返されました。',
        info,
        true,
        [{
          field: 'snapshot',
          expected: 'タスク一覧',
          actual: '入口の案内'
        }]
      );
    }

    if (result.unchanged === true) {
      const issues = [];

      if (action !== 'load') {
        issues.push({
          field: 'unchanged',
          expected: '一覧更新以外では使用しない',
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

      if (typeof result.revision !== 'string' || !result.revision) {
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

  function validTransition(value) {
    if (
      !isObject(value) ||
      !Array.isArray(value.days) ||
      !Array.isArray(value.tasks)
    ) {
      return false;
    }

    function validEntry(entry) {
      return isObject(entry) &&
        typeof entry.key === 'string' &&
        typeof entry.before === 'string' &&
        typeof entry.after === 'string';
    }

    if (
      !value.days.every(validEntry) ||
      !value.tasks.every(validEntry)
    ) {
      return false;
    }

    return ['periodic', 'undo'].every(function (key) {
      const entry = value[key];

      return entry === null ||
        (
          isObject(entry) &&
          typeof entry.before === 'string' &&
          typeof entry.after === 'string'
        );
    });
  }

  function requireMutationReceipt(result) {
    if (
      result.ok === true &&
      result.status === 'saved' &&
      validTransition(result.transition)
    ) {
      return;
    }

    throw receiveError(
      isEntryGuide(result) ? 'entry-guide' : 'mutation-receipt-shape',
      '保存成功の返答に必要な確認情報がありません。',
      result[RESPONSE_INFO] || summarizeResponse(result),
      false
    );
  }

  function shortRetryAllowed(error) {
    if (!error || error.supersededRead || error.serverStatus) {
      return false;
    }

    if (error.receiveCode === 'http') {
      return error.httpStatus === 404 ||
        (
          error.receiveInfo &&
          error.receiveInfo.httpStatus === 404
        );
    }

    return [
      'non-json',
      'response-envelope',
      'entry-guide',
      'mutation-receipt-shape',
      'snapshot-shape',
      'trace-mismatch'
    ].indexOf(error.receiveCode) >= 0;
  }

  function editValues(value) {
    return {
      title: String(value.title == null ? '' : value.title),
      due: String(value.due == null ? '' : value.due),
      date: String(value.date == null ? '' : value.date)
    };
  }

  function editFieldsFor(payload) {
    if (
      payload.editProtocol === EDIT_PROTOCOL &&
      isObject(payload.editBase)
    ) {
      return EDIT_FIELDS.filter(function (field) {
        return payload[field] !== payload.editBase[field];
      });
    }

    return EDIT_FIELDS.slice();
  }

  function normalizeEditConflict(value) {
    if (
      !isObject(value) ||
      value.protocol !== EDIT_PROTOCOL ||
      [
        'missing',
        'unavailable',
        'legacy-version',
        'changed-fields'
      ].indexOf(value.kind) < 0 ||
      ['active', 'completed', 'unknown'].indexOf(value.location) < 0 ||
      !Array.isArray(value.fields)
    ) {
      return null;
    }

    let current = null;

    if (value.current != null) {
      if (
        !isObject(value.current) ||
        !EDIT_FIELDS.every(function (field) {
          return typeof value.current[field] === 'string';
        }) ||
        typeof value.current.version !== 'string' ||
        !value.current.version
      ) {
        return null;
      }

      current = Object.assign(editValues(value.current), {
        hour: value.current.hour === null ||
          (
            Number.isInteger(value.current.hour) &&
            value.current.hour >= 8 &&
            value.current.hour <= 22
          )
          ? value.current.hour
          : null,
        version: value.current.version
      });
    }

    return {
      protocol: EDIT_PROTOCOL,
      kind: value.kind,
      location: value.location,
      fields: value.fields.filter(function (field) {
        return EDIT_FIELDS.indexOf(field) >= 0;
      }),
      current: current
    };
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

  function compatibleRecheck(job, snapshot) {
    if (
      !snapshot ||
      !snapshot.features ||
      job.state !== 'conflict' ||
      job.serverReceipt ||
      job.compatRechecked === 'v4.11.3'
    ) {
      return false;
    }

    const features = snapshot.features;

    if (
      job.payload.action === 'edit' &&
      features.completedTaskEdit === true &&
      features.taskEditFields === true &&
      features.taskEditProtocol === EDIT_PROTOCOL
    ) {
      const legacyMissing =
        !job.editConflict &&
        String(job.note || '').indexOf(
          'タスクが完了済みになったか、現在の一覧にありません。'
        ) >= 0;

      const oldServerRejectedFields =
        !job.editConflict &&
        job.payload.editProtocol === EDIT_PROTOCOL;

      return legacyMissing || oldServerRejectedFields;
    }

    return job.payload.action === 'automatic' &&
      features.automaticStateCheck === true &&
      typeof job.payload.enabled === 'boolean' &&
      job.payload.enabled === snapshot.periodic.automatic;
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
      this.activeRead = null;
      this.hiddenAt = document.hidden ? Date.now() : 0;
      this.lastHiddenDuration = 0;

      this.readStatus = {
        phase: 'idle',
        action: '',
        attempt: 0
      };

      this.readDiagnostics = [];
      this.readTraces = [];
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
      this.cancelRead('connection-changed');
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

    setReadStatus(phase, action, attempt, operation) {
      if (operation && this.activeRead !== operation) {
        return;
      }

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
        case 'waiting':
          return '通信の順番待ち';
        case 'reading':
          return '更新中';
        case 'retrying':
          return '一覧を取り直しています';
        case 'success':
          return this.readStatus.attempt === 2
            ? '再取得で更新成功'
            : '更新成功';
        case 'failed':
          return '前回の更新に失敗';
        case 'deferred':
          return '更新待ち';
        default:
          return 'この起動後は未確認';
      }
    }

    readActive(operation) {
      return this.activeRead === operation &&
        !operation.cancelled &&
        !this.paused;
    }

    readEvent(operation, name) {
      if (!operation) {
        return;
      }

      operation.events.push({
        name: name,
        at: new Date().toISOString(),
        elapsedMs: Math.max(0, Date.now() - operation.createdAt)
      });

      operation.events = operation.events.slice(-12);
    }

    cancelRead(reason) {
      const operation = this.activeRead;

      if (!operation || operation.cancelled) {
        return false;
      }

      operation.cancelled = true;
      operation.cancelReason = reason;
      this.readEvent(operation, reason);

      operation.controllers.forEach(function (controller) {
        controller.abort();
      });

      operation.releaseCancellation();
      return true;
    }

    async resumeReads() {
      const operation = this.activeRead;

      if (!operation) {
        return false;
      }

      this.readEvent(operation, 'visible');

      const now = Date.now();

      const hiddenDuration = this.hiddenAt
        ? Math.max(0, now - this.hiddenAt)
        : this.lastHiddenDuration;

      const totalAge = Math.max(0, now - operation.createdAt);
      const requestAge = operation.networkStartedAt
        ? Math.max(0, now - operation.networkStartedAt)
        : 0;

      let stale = false;

      if (operation.phase === 'request') {
        // 通信開始後は、順番待ちを含む総経過時間では判定しない。
        stale = requestAge >= REQUEST_TIMEOUT_MS ||
          (
            hiddenDuration >= RESUME_HIDDEN_TIME_MS &&
            requestAge >= RESUME_REQUEST_AGE_MS
          );
      } else if (
        ['waiting', 'retry-wait', 'preparing']
          .indexOf(operation.phase) >= 0
      ) {
        stale = totalAge >= REQUEST_TIMEOUT_MS;
      }

      // 受信後の照合・端末保存中は、通信の古さで中断しない。
      if (!operation.cancelled && !stale) {
        return false;
      }

      if (!operation.cancelled) {
        this.cancelRead('resume-expired');
      }

      if (operation.promise) {
        await operation.promise.catch(function () {
          return null;
        });
      }

      return true;
    }

    trackController(controller, operation) {
      this.controllers.add(controller);

      if (operation) {
        operation.controllers.add(controller);
      }
    }

    untrackController(controller, operation) {
      this.controllers.delete(controller);

      if (operation) {
        operation.controllers.delete(controller);
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
        this.cancelRead('storage-changed');
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
        this.readTraces = await this.readDiagnosticRecords(TRACE_KEY);
      } catch (error) {
        this.diagnosticWarning = '以前の通信の点検記録を読み取れませんでした。';
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
              this.readTraces = await this.readDiagnosticRecords(TRACE_KEY);

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

      document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
          this.hiddenAt = Date.now();
          this.readEvent(this.activeRead, 'hidden');
        } else if (this.hiddenAt) {
          this.lastHiddenDuration = Math.max(
            0,
            Date.now() - this.hiddenAt
          );

          this.hiddenAt = 0;
        }
      });

      window.addEventListener('pagehide', () => {
        this.paused = true;
        this.cancelRead('pagehide');

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

      if (!this.legacyCount) {
        await this.rearmCompatibleConflicts();
      }

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

    async rearmCompatibleConflicts() {
      if (
        !this.ready ||
        this.legacyCount ||
        !this.state.jobs.some((job) => {
          return compatibleRecheck(job, this.state.snapshot);
        })
      ) {
        return false;
      }

      return this.mutate(function (saved) {
        let changed = false;

        saved.jobs.forEach(function (job) {
          if (!compatibleRecheck(job, saved.snapshot)) {
            return;
          }

          // 受付番号・更新本文・frozenは変更しない。
          // 古い未送信に、推測した編集前の内容を付け足さない。
          job.compatRechecked = 'v4.11.3';
          job.state = 'saved';
          job.note = '';
          job.errorStatus = '';
          job.shortRetry = 0;
          job.retryAt = 0;
          changed = true;
        });

        return changed;
      });
    }

    async recheckConflict(id) {
      if (!navigator.onLine || !this.configured()) {
        throw new Error('通信できる状態で確認してください。');
      }

      await this.mutate(function (saved) {
        const job = saved.jobs.find(function (entry) {
          return entry.id === id && entry.state === 'conflict';
        });

        if (!job) {
          return;
        }

        if (
          job.payload.action !== 'edit' &&
          job.payload.action !== 'automatic'
        ) {
          return;
        }

        job.state = 'saved';
        job.retryAt = 0;
        job.shortRetry = 0;
        job.note = '';
        job.errorStatus = '';
      });

      await this.pump(true);
      await this.reloadLocal();

      return this.state.jobs.find(function (job) {
        return job.id === id;
      }) || null;
    }

    readDiagnosticRecords(key) {
      return new Promise((resolve, reject) => {
        const transaction = this.db.transaction('data', 'readonly');
        const request = transaction.objectStore('data')
          .get(key || DIAGNOSTIC_KEY);

        transaction.oncomplete = function () {
          resolve(
            Array.isArray(request.result)
              ? request.result.slice(-DIAGNOSTIC_LIMIT)
              : []
          );
        };

        transaction.onerror = transaction.onabort = function () {
          reject(
            transaction.error ||
            new Error('点検記録を読み取れませんでした。')
          );
        };
      });
    }

    async saveReadDiagnostic(record, asTrace) {
      const safeRecord = clone(record);
      const key = asTrace ? TRACE_KEY : DIAGNOSTIC_KEY;
      const property = asTrace ? 'readTraces' : 'readDiagnostics';

      try {
        const records = await new Promise((resolve, reject) => {
          const transaction = this.db.transaction('data', 'readwrite');
          const store = transaction.objectStore('data');
          const request = store.get(key);
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
            store.put(next, key);
          };

          transaction.oncomplete = function () {
            resolve(next);
          };

          transaction.onerror = transaction.onabort = function () {
            reject(
              transaction.error ||
              new Error('点検記録を保存できませんでした。')
            );
          };
        });

        this[property] = records;
        this.diagnosticWarning = '';

        if (this.channel) {
          this.channel.postMessage({
            type: 'read-diagnostics-changed'
          });
        }
      } catch (error) {
        this[property] = this[property].filter(function (entry) {
          return entry.id !== safeRecord.id;
        });

        this[property].push(safeRecord);
        this[property] = this[property].slice(-DIAGNOSTIC_LIMIT);

        this.diagnosticWarning =
          '通信の点検記録を端末に保存できませんでした。' +
          'この画面を閉じると記録が失われる場合があります。';
      }

      this.emit({
        kind: 'diagnostic'
      });
    }

    saveReadTrace(operation, outcome) {
      return this.saveReadDiagnostic({
        id: operation.id,
        at: operation.at,
        build: BUILD,
        action: safeAction(operation.action),
        outcome: outcome,
        phase: operation.phase,
        cancelled: operation.cancelled,
        cancelReason: operation.cancelReason || '',
        elapsedMs: Math.max(0, Date.now() - operation.createdAt),
        events: operation.events,
        attempts: operation.attempts
      }, true);
    }

    readTraceText() {
      const outcomes = {
        waiting: '開始・終了結果は未記録',
        reading: '送信開始・終了結果は未記録',
        success: '更新成功',
        failed: '更新失敗',
        cancelled: '古い一覧更新を終了',
        skipped: '今回は通信しない'
      };

      const events = {
        created: '更新を受け付けた',
        hidden: '画面が非表示になった',
        visible: '画面へ戻った',
        'resume-expired': '復帰時に古い一覧取得を終了した',
        pagehide: '画面を閉じたため一覧取得を終了した',
        'connection-changed': '接続設定の変更で一覧取得を終了した',
        'storage-changed': '端末保存の変更で一覧取得を終了した'
      };

      const lines = [
        '【読み取りの照合記録】',
        '照合番号はタスクID・保存操作の受付番号とは別の番号です。'
      ];

      if (!this.readTraces.length) {
        lines.push('記録：なし');
        return lines.join('\n');
      }

      this.readTraces.slice().reverse().forEach(function (record, index) {
        lines.push(
          '',
          '［' + (index + 1) + '］' + actionLabel(record.action),
          '照合番号：' + record.id,
          '開始：' + record.at,
          '結果：' + (outcomes[record.outcome] || '未確定'),
          '全体経過：' + (record.elapsedMs || 0) + 'ミリ秒'
        );

        (record.events || []).forEach(function (event) {
          lines.push(
            '・' + (events[event.name] || '状態の変化') +
            '／' + event.at +
            '／開始から' + event.elapsedMs + 'ミリ秒'
          );
        });

        (record.attempts || []).forEach(function (attempt) {
          const response = attempt.response || {};

          lines.push(
            '・試行' + attempt.number,
            '  送信開始：' + (attempt.sentAt || '送信前'),
            '  端末側の順番待ち：' + (
              Number.isFinite(attempt.queueMs)
                ? attempt.queueMs + 'ミリ秒'
                : '未記録'
            ),
            '  試行時間：' + (
              Number.isFinite(response.elapsedMs)
                ? response.elapsedMs + 'ミリ秒'
                : '未記録'
            ),
            '  応答番号：' + (
              response.httpStatus == null
                ? '未取得'
                : response.httpStatus
            ),
            '  GAS照合番号：' + (response.traceEcho || '返答未確認'),
            '  保存先処理：' + (
              Number.isFinite(response.serverMs)
                ? response.serverMs + 'ミリ秒'
                : '未取得'
            ),
            '  判定：' + (
              attempt.accepted
                ? '必要な情報を確認'
                : attempt.code || '終了結果は未記録'
            )
          );
        });
      });

      return lines.join('\n');
    }

    readDiagnosticText() {
      const records = this.readDiagnostics.slice().reverse();

      const outcomeNames = {
        retrying: '再確認開始・終了結果は未記録',
        recovered: '再確認で成功',
        failed: '失敗',
        interrupted: '再確認を中断'
      };

      const codeNames = {
        'non-json': 'JSONではない返答',
        'response-envelope': '返答全体の形式不一致',
        'server-version': '保存先の版の不一致',
        'entry-guide': '一覧ではなく入口の案内',
        'snapshot-shape': 'タスク一覧の形式不一致',
        'unchanged-shape': '変更なしの返答の形式不一致',
        'read-extra-shape': '画面別情報の形式不一致',
        'mutation-receipt-shape': '保存結果の確認情報が不足',
        'trace-mismatch': '要求と返答の照合番号が不一致',
        'cached-list-mismatch': '端末の一覧と変更なしの返答を照合できない',
        'server-rejection': '保存先が要求を受け付けなかった',
        'http': '通信の応答番号が正常ではない',
        'network': '接続失敗',
        'timeout': '応答待ち時間超過',
        'interrupted': '通信中断',
        'other': '通信または端末保存の処理で失敗'
      };

      const lines = [
        '通信の点検の版：' + BUILD,
        '【異常な返答の記録】'
      ];

      if (this.diagnosticWarning) {
        lines.push(this.diagnosticWarning);
      }

      if (!records.length) {
        lines.push('異常な返答の記録：なし');
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
          '記録時の版：' + (record.build || '未記録'),
          '操作：' + actionLabel(record.action),
          '結果：' + (outcomeNames[record.outcome] || '未確定')
        );

        if (record.traceId) {
          lines.push('読み取り照合番号：' + record.traceId);
        }

        (record.attempts || []).forEach(function (attempt) {
          const info = attempt.response || {};

          const redirected = typeof info.redirected === 'boolean'
            ? info.redirected ? 'あり' : 'なし'
            : info.redirected === null
              ? '確認できない'
              : '未記録';

          const entryGuide = typeof info.entryGuide === 'boolean'
            ? info.entryGuide ? '一致' : '一致しない'
            : info.entryGuide === null
              ? '判定できない'
              : '未記録';

          lines.push(
            '・' + attempt.number + '回目' +
              '／全体取得要求：' + (attempt.full ? 'あり' : 'なし') +
              '／' + (attempt.accepted ? '受理' : '不受理')
          );

          if (attempt.number > 1 && Number.isFinite(attempt.waitMs)) {
            lines.push(
              '  再確認前の待ち：' + attempt.waitMs + 'ミリ秒'
            );
          }

          lines.push(
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
            '  転送：' + redirected,
            '  最終到着先：' + (info.finalDestination || '未記録'),
            '  入口案内との一致：' + entryGuide,
            '  試行時間：' + (
              Number.isFinite(info.elapsedMs)
                ? info.elapsedMs + 'ミリ秒'
                : '未記録'
            ),
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

      lines.push('', this.readTraceText());
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
      const operation = settings.readOperation || null;

      const run = async () => {
        if (
          this.paused ||
          (operation && !this.readActive(operation))
        ) {
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
                return null;
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
        this.trackController(controller, operation);

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
          this.untrackController(controller, operation);
        }
      }

      const result = this.localTail.then(run);

      this.localTail = result.catch(function () {
        return undefined;
      });

      if (operation) {
        return Promise.race([
          result,
          operation.cancelPromise.then(function () {
            return SKIPPED;
          })
        ]);
      }

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

    async request(payload, forceFull, operation) {
      if (!this.configured()) {
        throw new Error('接続先と合い言葉を設定してください。');
      }

      if (operation && !this.readActive(operation)) {
        throw interruptedRead();
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
      const started = Date.now();
      const hint = this.clientHint(forceFull);
      let timedOut = false;

      let transport = {
        format: '返答なし',
        httpStatus: null,
        contentType: 'なし',
        redirected: null,
        finalDestination: '確認できない',
        traceEcho: operation ? '返答未確認' : '対象外'
      };

      if (operation) {
        hint.readTrace = {
          protocol: TRACE_PROTOCOL,
          id: operation.id,
          attempt: operation.attempt,
          build: BUILD
        };

        operation.networkStartedAt = started;
        operation.phase = 'request';
      }

      this.trackController(controller, operation);

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
            clientState: hint
          })),
          redirect: 'follow',
          cache: 'no-store',
          signal: controller.signal
        });

        transport = {
          format: '本文読取前',
          httpStatus: response.status,
          contentType: safeContentType(response.headers.get('Content-Type')),
          redirected: response.redirected,
          finalDestination: finalDestination(response.url, config.url),
          elapsedMs: Math.max(0, Date.now() - started),
          traceEcho: operation ? '返答未確認' : '対象外'
        };

        if (!response.ok) {
          const retryable404 = response.status === 404;

          const error = receiveError(
            'http',
            '保存先から正常な返答を受け取れませんでした' +
              '（応答番号：' + response.status + '）。',
            summarizeResponse(undefined, transport),
            retryable404 && READ_ACTIONS.indexOf(payload.action) >= 0,
            [],
            retryable404 ? READ_RETRY_DELAY_MS : 0
          );

          error.httpStatus = response.status;
          throw error;
        }

        const text = await response.text();
        transport.elapsedMs = Math.max(0, Date.now() - started);
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

        if (operation) {
          if (!isObject(result) || result.readTrace == null) {
            transport.traceEcho = '返答に照合番号なし';
          } else {
            const trace = result.readTrace;

            const matched = isObject(trace) &&
              trace.protocol === TRACE_PROTOCOL &&
              trace.id === operation.id &&
              trace.attempt === operation.attempt;

            transport.traceEcho = matched ? '一致' : '不一致';

            if (!matched) {
              throw receiveError(
                'trace-mismatch',
                '送った一覧取得と、届いた返答の照合番号が一致しません。',
                summarizeResponse(result, transport),
                true
              );
            }
          }
        }

        const info = summarizeResponse(result, transport);

        if (!isObject(result) || typeof result.ok !== 'boolean') {
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
          this.verifiedConnection = '';
          this.verifiedFeatures = {};

          throw receiveError(
            'server-version',
            'この画面に対応する保存先ではありません。',
            info,
            false
          );
        }

        if (operation && !this.readActive(operation)) {
          throw interruptedRead();
        }

        if (result.ok && !isEntryGuide(result)) {
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
          milliseconds: Math.max(0, Date.now() - started),
          serverMs: Number.isFinite(result.serverMs)
            ? result.serverMs
            : null
        };

        return result;
      } catch (error) {
        transport.elapsedMs = Math.max(0, Date.now() - started);

        if (operation && !this.readActive(operation)) {
          throw interruptedRead();
        }

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
          if (error.receiveInfo) {
            error.receiveInfo.elapsedMs = transport.elapsedMs;
          }

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
        this.untrackController(controller, operation);
      }
    }

    waitBeforeReadRetry(milliseconds, operation) {
      if (milliseconds <= 0) {
        return Promise.resolve();
      }

      return new Promise((resolve, reject) => {
        const controller = new AbortController();
        let timer = null;
        let settled = false;

        const finish = (error) => {
          if (settled) {
            return;
          }

          settled = true;
          clearTimeout(timer);
          this.untrackController(controller, operation);

          if (error) {
            reject(error);
          } else {
            resolve();
          }
        };

        controller.signal.addEventListener('abort', function () {
          finish(operation
            ? interruptedRead()
            : new Error('再確認を中断しました。'));
        }, {
          once: true
        });

        this.trackController(controller, operation);

        if (
          this.paused ||
          (operation && !this.readActive(operation))
        ) {
          controller.abort();
          return;
        }

        timer = setTimeout(function () {
          finish(null);
        }, milliseconds);
      });
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

    async acceptRead(result, operation) {
      if (operation && !this.readActive(operation)) {
        throw interruptedRead();
      }

      let accepted;

      if (result.unchanged) {
        accepted = await this.mutate((saved) => {
          if (operation && !this.readActive(operation)) {
            throw interruptedRead();
          }

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
      } else {
        requireSnapshot(result.snapshot, result[RESPONSE_INFO]);

        await this.mutate((saved) => {
          if (operation && !this.readActive(operation)) {
            throw interruptedRead();
          }

          storeSnapshot(saved, result.snapshot);
          saved.lastNetworkAt = Date.now();
        });

        accepted = true;
      }

      if (accepted && !this.legacyCount) {
        await this.rearmCompatibleConflicts();
      }

      return accepted;
    }

    async performRead(payload, settings, operation) {
      let full = !!settings.forceFull;
      let diagnostic = null;
      let waitMs = 0;

      await this.saveReadTrace(operation, 'waiting');

      for (let attempt = 1; attempt <= 2; attempt++) {
        let response = null;
        let attemptRecord = null;

        try {
          if (!this.readActive(operation)) {
            throw interruptedRead();
          }

          operation.attempt = attempt;
          operation.phase = attempt === 1 ? 'waiting' : 'retry-wait';

          this.setReadStatus(
            attempt === 1 ? 'waiting' : 'retrying',
            payload.action,
            attempt,
            operation
          );

          if (waitMs > 0) {
            await this.waitBeforeReadRetry(waitMs, operation);
          }

          if (!this.readActive(operation)) {
            throw interruptedRead();
          }

          this.state = await this.readState();

          if (readyJob(this.state, false)) {
            await this.pump(false);
          }

          if (!this.readActive(operation)) {
            throw interruptedRead();
          }

          operation.phase = 'waiting';
          const queuedAt = Date.now();

          const result = await this.withNetwork(async () => {
            if (!this.readActive(operation)) {
              throw interruptedRead();
            }

            this.state = await this.readState();

            if (
              settings.background &&
              (
                this.state.jobs.length ||
                (
                  attempt === 1 &&
                  Date.now() - (this.state.lastNetworkAt || 0) < 20000
                )
              )
            ) {
              return SKIPPED;
            }

            operation.phase = 'preparing';

            attemptRecord = {
              number: attempt,
              full: full,
              waitMs: waitMs,
              queueMs: Math.max(0, Date.now() - queuedAt),
              sentAt: new Date().toISOString(),
              accepted: false,
              code: '',
              response: null,
              issues: []
            };

            operation.attempts.push(attemptRecord);
            await this.saveReadTrace(operation, 'reading');

            if (!this.readActive(operation)) {
              throw interruptedRead();
            }

            this.setReadStatus(
              attempt === 1 ? 'reading' : 'retrying',
              payload.action,
              attempt,
              operation
            );

            response = await this.request(payload, full, operation);

            if (!this.readActive(operation)) {
              throw interruptedRead();
            }

            operation.phase = 'receiving';
            validateReadResponse(payload.action, response, full);

            const accepted = await this.acceptRead(response, operation);

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

            return response;
          }, {
            opportunistic: !!settings.background,
            readOperation: operation
          });

          if (!this.readActive(operation)) {
            throw interruptedRead();
          }

          if (result === SKIPPED) {
            operation.phase = 'deferred';

            this.setReadStatus(
              'deferred',
              payload.action,
              attempt,
              operation
            );

            if (diagnostic) {
              diagnostic.outcome = 'interrupted';
              await this.saveReadDiagnostic(diagnostic);
            }

            await this.saveReadTrace(operation, 'skipped');
            return null;
          }

          attemptRecord.accepted = true;
          attemptRecord.response = response[RESPONSE_INFO] ||
            summarizeResponse(response);

          if (diagnostic) {
            diagnostic.attempts.push(clone(attemptRecord));
            diagnostic.outcome = 'recovered';
            await this.saveReadDiagnostic(diagnostic);
          }

          if (!this.readActive(operation)) {
            throw interruptedRead();
          }

          this.markReceived(true);
          this.setReadStatus('success', payload.action, attempt, operation);

          operation.phase = 'finished';
          await this.saveReadTrace(operation, 'success');

          return this.readActive(operation) ? response : null;
        } catch (error) {
          if (
            operation.cancelled ||
            this.paused ||
            error.supersededRead
          ) {
            operation.phase = 'cancelled';

            if (diagnostic) {
              diagnostic.outcome = 'interrupted';
              await this.saveReadDiagnostic(diagnostic);
            }

            await this.saveReadTrace(operation, 'cancelled');
            return null;
          }

          operation.phase = 'failed-attempt';

          const recordedAttempt = attemptRecord || {
            number: attempt,
            full: full,
            waitMs: waitMs,
            queueMs: null,
            sentAt: '',
            accepted: false,
            issues: []
          };

          recordedAttempt.code = error.receiveCode || 'other';
          recordedAttempt.response = error.receiveInfo ||
            (
              response
                ? response[RESPONSE_INFO] || summarizeResponse(response)
                : summarizeResponse(undefined, {
                  format: '返答を確認できない'
                })
            );

          recordedAttempt.issues = error.receiveIssues || [];

          if (!attemptRecord) {
            operation.attempts.push(recordedAttempt);
          }

          if (!diagnostic) {
            diagnostic = {
              id: uuid(),
              at: new Date().toISOString(),
              build: BUILD,
              action: safeAction(payload.action),
              traceId: operation.id,
              outcome: 'failed',
              attempts: []
            };
          }

          diagnostic.attempts.push(clone(recordedAttempt));

          if (attempt === 1 && error.retryFull === true) {
            diagnostic.outcome = 'retrying';
            await this.saveReadDiagnostic(diagnostic);

            full = true;
            waitMs = Math.max(
              READ_RETRY_DELAY_MS,
              Number.isFinite(error.retryAfterMs)
                ? error.retryAfterMs
                : 0
            );

            continue;
          }

          diagnostic.outcome = 'failed';
          await this.saveReadDiagnostic(diagnostic);

          const message = attempt === 2
            ? '一覧を取り直しましたが、更新できませんでした。\n' +
              String(error.message || error)
            : String(error.message || error);

          if (this.readActive(operation)) {
            this.lastReadError = message;
            this.setReadStatus('failed', payload.action, attempt, operation);
          }

          operation.phase = 'finished';
          await this.saveReadTrace(operation, 'failed');

          if (!this.readActive(operation)) {
            return null;
          }

          throw new Error(message);
        }
      }

      return null;
    }

    async read(payload, options) {
      const settings = options || {};

      if (!this.ready || this.legacyCount) {
        throw new Error('端末保存の準備ができていません。');
      }

      if (READ_ACTIONS.indexOf(payload.action) < 0) {
        throw new Error('読み取り用の操作ではありません。');
      }

      if (this.paused) {
        return null;
      }

      const key = JSON.stringify([
        payload.action,
        payload.offset || 0,
        !!settings.forceFull,
        !!settings.background
      ]);

      if (this.activeRead) {
        const previous = this.activeRead;

        if (!previous.cancelled && previous.key === key) {
          return previous.promise;
        }

        if (settings.background) {
          return null;
        }

        await previous.promise.catch(function () {
          return null;
        });

        return this.read(payload, settings);
      }

      let releaseCancellation;

      const operation = {
        id: uuid(),
        key: key,
        action: payload.action,
        at: new Date().toISOString(),
        createdAt: Date.now(),
        networkStartedAt: 0,
        phase: 'waiting',
        attempt: 0,
        attempts: [],
        events: [],
        controllers: new Set(),
        cancelled: false,
        cancelReason: '',
        promise: null,
        cancelPromise: new Promise(function (resolve) {
          releaseCancellation = resolve;
        }),
        releaseCancellation: function () {
          releaseCancellation();
        }
      };

      this.activeRead = operation;
      this.readEvent(operation, 'created');

      operation.promise = this.performRead(
        clone(payload),
        settings,
        operation
      ).finally(() => {
        if (this.activeRead === operation) {
          this.activeRead = null;

          if (operation.cancelled) {
            this.setReadStatus('deferred', payload.action, 0);
          }
        }

        this.pump(false);
      });

      return operation.promise;
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
        if (
          payload.action === 'automatic' &&
          saved.jobs.some(function (job) {
            return job.payload.action === 'automatic';
          })
        ) {
          throw new Error(
            '自動追加の変更が送信待ちです。先に保存結果を確認してください。'
          );
        }

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

    async rememberMutationReceipt(job, result) {
      requireMutationReceipt(result);

      const receipt = {
        status: 'saved',
        transition: clone(result.transition),
        result: isObject(result.result) ? clone(result.result) : {},
        message: typeof result.message === 'string' ? result.message : '',
        serverMs: Number.isFinite(result.serverMs) ? result.serverMs : null,
        confirmedAt: new Date().toISOString()
      };

      await this.mutate(function (saved) {
        const current = saved.jobs.find(function (entry) {
          return entry.id === job.id;
        });

        if (current) {
          current.serverReceipt = receipt;
        }
      });

      job.serverReceipt = receipt;
    }

    async finishConfirmedMutation(job, started, immediateResult) {
      const receipt = job.serverReceipt;

      if (!receipt || !validTransition(receipt.transition)) {
        throw new Error(
          '端末に残した保存確認情報を読み取れません。データは消さないでください。'
        );
      }

      let result = immediateResult;
      let accepted = false;

      if (result && (result.snapshot || result.patch)) {
        try {
          accepted = await this.acceptMutation(
            job,
            result,
            Math.max(0, Date.now() - started)
          );
        } catch (error) {
          if (
            error.receiveCode !== 'snapshot-shape' &&
            error.message !== '届いた変更内容を読み取れませんでした。'
          ) {
            throw error;
          }
        }
      }

      if (!accepted) {
        const full = await this.request({
          action: 'load'
        }, true);

        validateReadResponse('load', full, true);

        result = {
          ok: true,
          app: SERVER_VERSION,
          build: full.build,
          status: 'saved',
          message: receipt.message,
          snapshot: full.snapshot,
          transition: clone(receipt.transition),
          result: clone(receipt.result),
          serverMs: receipt.serverMs
        };

        accepted = await this.acceptMutation(
          job,
          result,
          Math.max(0, Date.now() - started)
        );
      }

      if (!accepted) {
        throw new Error('保存後の一覧を確認できませんでした。');
      }

      return result;
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
        current.errorStatus = '';
        current.shortRetry = 0;
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

      const started = Date.now();
      let diagnostic = null;
      let finalError = null;

      for (let attempt = 1; attempt <= 3; attempt++) {
        let result = null;

        try {
          if (this.paused) {
            throw new Error('画面の終了後に送信を続行しません。');
          }

          const config = this.config();
          const connection = config.url + '\n' + config.token;

          if (
            !job.serverReceipt &&
            job.payload.action === 'periodicSave' &&
            Object.prototype.hasOwnProperty.call(job.payload, 'dueRule') &&
            this.verifiedConnection !== connection
          ) {
            const checked = await this.request({
              action: 'load'
            }, true);

            validateReadResponse('load', checked, true);

            if (
              !checked.snapshot.features ||
              !checked.snapshot.features.periodicDue
            ) {
              throw new Error('保存先が期限設定に対応していません。');
            }

            await this.acceptRead(checked);
          }

          if (job.serverReceipt) {
            result = await this.finishConfirmedMutation(job, started, null);
          } else {
            result = await this.request(job.payload, false);

            if (result.ok) {
              await this.rememberMutationReceipt(job, result);
              result = await this.finishConfirmedMutation(job, started, result);
            } else {
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
                    current.shortRetry = 0;
                    current.errorStatus = result.status;

                    if (current.payload.action === 'edit') {
                      current.editConflict = normalizeEditConflict(
                        result.editConflict
                      );
                    }
                  }

                  if (
                    result.snapshot &&
                    snapshotIssues(result.snapshot).length === 0
                  ) {
                    storeSnapshot(saved, result.snapshot);
                    saved.lastNetworkAt = Date.now();
                  }
                });

                return {
                  saved: false,
                  stop: false
                };
              }

              const error = receiveError(
                'server-rejection',
                result.message || '保存結果を確認できませんでした。',
                result[RESPONSE_INFO] || summarizeResponse(result),
                false
              );

              error.serverStatus = safeStatus(result.status);
              throw error;
            }
          }

          if (diagnostic) {
            diagnostic.outcome = 'recovered';

            diagnostic.attempts.push({
              number: attempt,
              full: !!job.serverReceipt,
              waitMs: attempt === 2 ? 2000 : attempt === 3 ? 5000 : 0,
              accepted: true,
              code: '',
              response: result[RESPONSE_INFO] || summarizeResponse(result),
              issues: []
            });

            await this.saveReadDiagnostic(diagnostic);
          }

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
        } catch (error) {
          if (this.paused) {
            throw error;
          }

          finalError = error;

          if (!diagnostic) {
            diagnostic = {
              id: uuid(),
              at: new Date().toISOString(),
              build: BUILD,
              action: safeAction(job.payload.action),
              outcome: 'failed',
              attempts: []
            };
          }

          diagnostic.attempts.push({
            number: attempt,
            full: !!job.serverReceipt,
            waitMs: attempt === 2 ? 2000 : attempt === 3 ? 5000 : 0,
            accepted: false,
            code: error.receiveCode || 'other',
            response: error.receiveInfo ||
              (
                result
                  ? result[RESPONSE_INFO] || summarizeResponse(result)
                  : summarizeResponse(undefined)
              ),
            issues: error.receiveIssues || []
          });

          if (attempt < 3 && shortRetryAllowed(error)) {
            diagnostic.outcome = 'retrying';
            await this.saveReadDiagnostic(diagnostic);

            await this.mutate(function (saved) {
              const current = saved.jobs.find(function (entry) {
                return entry.id === job.id;
              });

              if (current) {
                current.shortRetry = attempt;
                current.state = 'sending';
                current.note = '';
              }
            });

            await this.waitBeforeReadRetry(attempt === 1 ? 2000 : 5000);
            continue;
          }

          break;
        }
      }

      if (diagnostic) {
        diagnostic.outcome = 'failed';
        await this.saveReadDiagnostic(diagnostic);
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
        current.shortRetry = 0;

        const authentication =
          finalError.serverStatus === 'denied' ||
          finalError.serverStatus === 'needs_setup' ||
          finalError.receiveCode === 'server-version';

        const delay = authentication
          ? 300000
          : Math.min(
            300000,
            5000 * Math.pow(2, Math.min(current.attempts - 1, 6))
          );

        current.state = 'unknown';
        current.errorStatus = authentication ? 'authentication' : '';
        current.retryAt = Date.now() + delay;

        current.note = String(finalError.message || finalError) +
          (
            current.serverReceipt
              ? '\n保存成功の返答は確認しています。更新要求ではなく一覧を確認します。'
              : '\n未反映とは限りません。同じ受付番号・同じ更新内容で再確認します。'
          );
      });

      return {
        saved: false,
        stop: true
      };
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
                  : job.shortRetry
                    ? '再確認中・端末に保存済み'
                    : job.state === 'sending' || job.state === 'unknown'
                      ? '保存結果を確認中'
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
            editFieldsFor(payload).forEach(function (field) {
              task[field] = payload[field];
            });
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

    async resolveConflict(id, useLocal, reviewedIds, reviewed) {
      const review = reviewed || {};

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

        const expected = (reviewedIds || []).slice().sort();

        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          throw new Error(
            '確認中に関連する操作が増えました。確認画面を開き直してください。'
          );
        }

        if (related.some(function (job) {
          return job.id !== id && job.frozen;
        })) {
          throw new Error(
            '関連する保存結果を確認中です。少し待って開き直してください。'
          );
        }

        const ids = new Set(actual);

        if (!useLocal) {
          saved.jobs = saved.jobs.filter(function (job) {
            return !ids.has(job.id);
          });
          return;
        }

        if (!saved.snapshot) {
          throw new Error('保存先の内容を確認してから操作してください。');
        }

        let simulatedEdit = null;
        let editVersion = '';
        const rootTaskId = root.payload.taskId || '';

        if (root.payload.action === 'edit') {
          const features = saved.snapshot.features || {};
          const current = normalizeEditConflict(root.editConflict);
          const confirmed = normalizeEditConflict(review.edit);

          if (
            !features.taskEditFields ||
            features.taskEditProtocol !== EDIT_PROTOCOL ||
            !current ||
            !current.current ||
            !confirmed ||
            !confirmed.current ||
            JSON.stringify(current) !== JSON.stringify(confirmed)
          ) {
            throw new Error(
              '編集先の内容を確認し直してください。タスクを勝手に作り直すことはありません。'
            );
          }

          simulatedEdit = editValues(confirmed.current);
          editVersion = confirmed.current.version;
        } else if (root.payload.action === 'automatic') {
          if (
            typeof review.automatic !== 'boolean' ||
            review.automatic !== saved.snapshot.periodic.automatic
          ) {
            throw new Error('設定が変わりました。確認画面を開き直してください。');
          }
        } else if (
          review.revision &&
          review.revision !== saved.snapshot.revision
        ) {
          throw new Error('内容が変わりました。確認画面を開き直してください。');
        }

        const replacements = new Map();

        related.forEach(function (job) {
          replacements.set(job.id, uuid());
        });

        related.forEach(function (job) {
          const oldId = job.id;
          const isRoot = oldId === id;
          const payload = job.payload;
          const newId = replacements.get(oldId);

          if (
            simulatedEdit &&
            payload.taskId === rootTaskId &&
            payload.action === 'edit'
          ) {
            const fields = editFieldsFor(payload);
            const base = editValues(simulatedEdit);
            const next = editValues(base);

            fields.forEach(function (field) {
              next[field] = payload[field];
            });

            payload.title = next.title;
            payload.due = next.due;
            payload.date = next.date;
            payload.editProtocol = EDIT_PROTOCOL;
            payload.editBase = base;
            payload.expectedTask = editVersion;

            simulatedEdit = next;
            job.label = '編集：' + next.title;
          } else if (
            simulatedEdit &&
            payload.taskId === rootTaskId &&
            payload.action === 'done'
          ) {
            payload.expectedTask = editVersion;
          } else if (isRoot && payload.action === 'order') {
            payload.expectedDay = dayVersion(saved.snapshot, payload.date);
            payload.items = mergePlan(
              payload.items,
              saved.snapshot.tasks,
              payload.date
            );
          } else if (isRoot && payload.action === 'automatic') {
            payload.expectedPeriodic = saved.snapshot.periodic.version;
            payload.expectedAutomatic = saved.snapshot.periodic.automatic;
          } else if (isRoot && payload.expectedPeriodic) {
            payload.expectedPeriodic = saved.snapshot.periodic.version;
          } else if (isRoot && payload.expectedUndo) {
            payload.expectedUndo = saved.snapshot.undo.version;
          } else if (isRoot && payload.taskId) {
            const task = taskById(saved.snapshot, payload.taskId);

            if (!task) {
              throw new Error('対象のタスクを確認できません。');
            }

            payload.expectedTask = task.version;
          }

          // 関連する別タスクの版は、無条件に最新へ置き換えない。
          job.id = newId;
          payload.requestId = newId;
          job.frozen = false;
          job.state = 'saved';
          job.note = '';
          job.errorStatus = '';
          job.shortRetry = 0;
          job.retryAt = 0;
          job.attempts = 0;
          job.createdAt = Date.now();

          delete job.firstSentAt;
          delete job.lastAttemptAt;
          delete job.serverReceipt;
          delete job.editConflict;
          delete job.compatRechecked;

          job.keys = Array.from(new Set(
            (job.keys || []).concat(resources(payload, saved.snapshot))
          ));

          job.causes = (job.causes || []).map(function (cause) {
            return replacements.get(cause) || cause;
          });
        });
      });

      this.pump(false);
    }
  }

  window.TaskCore = {
    VERSION: VERSION,
    BUILD: BUILD,
    EDIT_PROTOCOL: EDIT_PROTOCOL,
    create: function (options) {
      return new TaskClient(options);
    },
    emptyState: emptyState,
    clone: clone,
    compareTasks: compareTasks,
    taskById: taskById,
    dayVersion: dayVersion,
    mergePlan: mergePlan,
    editValues: editValues,
    editFields: editFieldsFor
  };
})();
