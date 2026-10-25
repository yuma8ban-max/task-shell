// File: task-core.js
(function () {
  'use strict';

  const VERSION = 'v4.8';
  const BUILD = 'v4.12.1';
  const SERVER_VERSION = 'v4.3';

  const SYNC_PROTOCOL = 'task-sync-v1';
  const TRACE_PROTOCOL = 'task-read-trace-v1';
  const EDIT_PROTOCOL = 'task-edit-fields-v1';
  const PLAN_PROTOCOL = 'task-plan-move-v1';
  const LATEST_PROTOCOL = 'task-latest-op-v1';

  const DB_NAME = 'taskapp-unified';
  const URL_KEY = 'gasUrl_v1';
  const TOKEN_KEY = 'gasTok_v1';
  const CHANNEL_NAME = 'task-unified-state';
  const WISH_CHANNEL = 'task-wishes-v1';
  const NETWORK_LOCK = 'taskapp-unified-remote-v1';

  const DIAGNOSTIC_KEY = 'read-receipt-checks-v1';
  const TRACE_KEY = 'read-traces-v1';
  const CLOCK_KEY = 'latest-operation-clock-v1';

  const DIAGNOSTIC_LIMIT = 12;
  const CLOCK_SAMPLE_LIMIT = 24;
  const REQUEST_TIMEOUT_MS = 60000;
  const READ_RETRY_DELAY_MS = 2000;
  const RESUME_REQUEST_AGE_MS = 30000;
  const RESUME_HIDDEN_TIME_MS = 15000;

  const RESPONSE_INFO = Symbol('response-info');
  const SKIPPED = Symbol('skipped');

  const READ_ACTIONS = [
    'load',
    'history',
    'preview',
    'check'
  ];

  const TASK_ACTIONS = [
    'add',
    'order',
    'planMove',
    'edit',
    'done',
    'undo',
    'periodicSave',
    'periodicSend',
    'periodicRun',
    'automatic'
  ];

  const WISH_ACTIONS = [
    'wishAdd',
    'wishEdit',
    'wishDone',
    'wishRestore'
  ];

  const WRITE_ACTIONS = TASK_ACTIONS.concat(WISH_ACTIONS);

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

  const LATEST_OUTCOMES = [
    'applied',
    'merged',
    'superseded',
    'baseline',
    'completed',
    'expired',
    'legacy'
  ];

  const EDIT_FIELDS = [
    'title',
    'due',
    'date'
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

  function isObject(value) {
    return !!value &&
      typeof value === 'object' &&
      !Array.isArray(value);
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

  function checkedClock(value) {
    if (value == null) {
      return {
        actor: uuid(),
        sequence: 0,
        lastNewAt: 0,
        samples: []
      };
    }

    if (
      !isObject(value) ||
      typeof value.actor !== 'string' ||
      !/^[0-9A-Za-z-]{1,64}$/.test(value.actor) ||
      !Number.isSafeInteger(value.sequence) ||
      value.sequence < 0 ||
      !Array.isArray(value.samples)
    ) {
      throw new Error(
        '操作順の端末記録を読み取れません。記録は消さずに確認してください。'
      );
    }

    if (!Number.isSafeInteger(value.lastNewAt)) {
      value.lastNewAt = 0;
    }

    value.samples = value.samples.filter(function (sample) {
      return isObject(sample) &&
        Number.isFinite(sample.localAt) &&
        Number.isFinite(sample.offset) &&
        Number.isFinite(sample.roundTrip);
    }).slice(-CLOCK_SAMPLE_LIMIT);

    return value;
  }

  function sampleFor(clock, when) {
    if (!clock.samples.length) {
      return null;
    }

    const earlier = clock.samples.filter(function (sample) {
      return sample.localAt <= when;
    });

    if (earlier.length) {
      return earlier[earlier.length - 1];
    }

    return clock.samples[0];
  }

  function validOrder(order, requestId) {
    return isObject(order) &&
      order.protocol === LATEST_PROTOCOL &&
      order.requestId === requestId &&
      Number.isSafeInteger(order.at) &&
      order.at > 0 &&
      typeof order.actor === 'string' &&
      /^[0-9A-Za-z-]{1,64}$/.test(order.actor) &&
      Number.isSafeInteger(order.sequence) &&
      order.sequence >= 0;
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

    const names = {
      object: '項目の組',
      string: '文字列',
      number: '数値',
      boolean: '真偽値'
    };

    return names[typeof value] || 'その他';
  }

  function safeVersion(value) {
    return typeof value === 'string' &&
      value.length <= 40 &&
      /^v\d+(?:\.\d+){0,4}(?:-\d+)?$/.test(value)
        ? value
        : value == null
          ? 'なし'
          : '指定外';
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
    return READ_ACTIONS.concat(WRITE_ACTIONS, ['wishList'])
      .indexOf(value) >= 0
        ? value
        : 'その他';
  }

  function safeOutcome(value) {
    return LATEST_OUTCOMES.indexOf(value) >= 0
      ? value
      : 'legacy';
  }

  function actionLabel(value) {
    const names = {
      load: '一覧更新',
      history: '完了済み更新',
      preview: '定期タスクの対象確認',
      check: '動作確認',
      add: '追加',
      order: '配置',
      planMove: '計画への移動',
      edit: '編集',
      done: '完了',
      undo: '取り消し',
      periodicSave: '定期設定',
      periodicSend: '定期追加',
      periodicRun: '今日の定期追加',
      automatic: '自動追加設定',
      wishList: 'したいこと更新',
      wishAdd: 'したいこと追加',
      wishEdit: 'したいこと編集',
      wishDone: '達成',
      wishRestore: '達成を戻す'
    };

    return names[value] || 'その他';
  }

  function outcomeLabel(value) {
    const names = {
      applied: '操作を反映',
      merged: '他の新しい変更と合わせて反映',
      superseded: 'より新しい操作を優先',
      baseline: '旧記録を保存先の現在値に合わせた',
      completed: '完了状態を維持',
      expired: '日付が変わった要求を実行しなかった',
      legacy: '従来形式の処理を確認'
    };

    return names[safeOutcome(value)];
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

    const expected = ['ok', 'app', 'build', 'message'];
    const keys = Object.keys(value);

    return keys.length === expected.length &&
      keys.every(function (key) {
        return expected.indexOf(key) >= 0;
      }) &&
      value.ok === true &&
      value.app === SERVER_VERSION &&
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
      latestOutcome: safeOutcome(
        source.result && source.result.latestOutcome
      ),
      taskCount: Array.isArray(snapshot.tasks)
        ? snapshot.tasks.length
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
      ]
    };
  }

  function receiveError(code, message, info, retryFull, issues, delay) {
    const error = new Error(message);
    error.receiveCode = code;
    error.receiveInfo = info || null;
    error.retryFull = retryFull === true;
    error.receiveIssues = issues || [];
    error.retryAfterMs = Number.isFinite(delay) ? Math.max(0, delay) : 0;
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
        Number.isInteger(snapshot.undo.count) && snapshot.undo.count >= 0,
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
      const seen = new Set();

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
          typeof task.taskId === 'string' &&
            !!task.taskId &&
            !seen.has(task.taskId),
          '重複しない空でない文字列'
        );

        seen.add(task.taskId);

        ['title', 'due', 'date'].forEach(function (field) {
          expect(
            prefix + '.' + field,
            task[field],
            typeof task[field] === 'string',
            '文字列'
          );
        });

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
        true
      );
    }

    if (result.unchanged === true) {
      const valid =
        action === 'load' &&
        !forceFull &&
        typeof result.revision === 'string' &&
        !!result.revision &&
        typeof result.fetchedAt === 'string' &&
        Number.isFinite(Date.parse(result.fetchedAt));

      if (!valid) {
        throw receiveError(
          'unchanged-shape',
          '変更なしという返答を、現在の一覧と照合できませんでした。',
          info,
          true
        );
      }

      return;
    }

    requireSnapshot(result.snapshot, info);

    let valid = true;

    if (action === 'history') {
      valid = isObject(result.history) &&
        Array.isArray(result.history.items) &&
        Number.isInteger(result.history.total) &&
        result.history.total >= 0;
    }

    if (action === 'preview') {
      valid = isObject(result.preview) &&
        Array.isArray(result.preview.items) &&
        Array.isArray(result.preview.errors) &&
        typeof result.preview.version === 'string' &&
        !!result.preview.version &&
        /^\d{4}-\d{2}-\d{2}$/.test(result.preview.date || '');
    }

    if (action === 'check') {
      valid = Array.isArray(result.checks) &&
        result.checks.every(function (item) {
          return typeof item === 'string';
        });
    }

    if (!valid) {
      throw receiveError(
        'read-extra-shape',
        '保存先の返答に、この画面の表示に必要な情報が含まれていません。',
        info,
        true
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

    function entryValid(entry) {
      return isObject(entry) &&
        typeof entry.key === 'string' &&
        typeof entry.before === 'string' &&
        typeof entry.after === 'string';
    }

    if (
      !value.days.every(entryValid) ||
      !value.tasks.every(entryValid)
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
      '保存結果に必要な確認情報がありません。',
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

    const byId = new Map(available.map(function (task) {
      return [task.taskId, task];
    }));

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
    const id = payload.taskId || payload.movedTaskId || '';

    if (
      payload.date &&
      ['add', 'edit', 'order', 'planMove'].indexOf(payload.action) >= 0
    ) {
      keys.push('day:' + payload.date);
    }

    if (payload.action === 'planMove' && payload.fromDate) {
      keys.push('day:' + payload.fromDate);
    }

    if (id) {
      keys.push('task:' + id);

      const task = taskById(snapshot, id);

      if (task && task.date) {
        keys.push('day:' + task.date);
      }
    }

    if (
      payload.action.indexOf('periodic') === 0 ||
      payload.action === 'automatic'
    ) {
      keys.push('periodic');
    }

    if (payload.action === 'done' || payload.action === 'undo') {
      keys.push('undo');
    }

    if (payload.action === 'undo' && Array.isArray(payload.undoTargets)) {
      payload.undoTargets.forEach(function (taskId) {
        keys.push('task:' + taskId);
      });
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
        ['order', 'planMove'].indexOf(payload.action) >= 0 &&
        payload.date === entry.key &&
        payload.expectedDay === entry.before
      ) {
        payload.expectedDay = entry.after;
      }

      if (
        payload.action === 'planMove' &&
        payload.fromDate === entry.key &&
        payload.expectedFromDay === entry.before
      ) {
        payload.expectedFromDay = entry.after;
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

  function readyJob(saved, force) {
    const ids = new Set(saved.jobs.map(function (job) {
      return job.id;
    }));

    return saved.jobs.slice().sort(function (a, b) {
      return a.sequence - b.sequence;
    }).find(function (job) {
      return ['saved', 'unknown', 'sending'].indexOf(job.state) >= 0 &&
        (force || !job.retryAt || job.retryAt <= Date.now()) &&
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
      !isObject(patch) ||
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

      if (
        Number.isFinite(Date.parse(patch.fetchedAt || '')) &&
        Date.parse(patch.fetchedAt) >=
          Date.parse(saved.snapshot.fetchedAt || '')
      ) {
        saved.snapshot.fetchedAt = patch.fetchedAt;
      }

      if (patch.features) {
        saved.snapshot.features = patch.features;
      }

      if (patch.build) {
        saved.snapshot.build = patch.build;
      }

      return true;
    }

    if (
      !saved.snapshot ||
      saved.snapshot.revision !== patch.baseRevision
    ) {
      return false;
    }

    const next = clone(saved.snapshot);
    const tasks = new Map(next.tasks.map(function (task) {
      return [task.taskId, task];
    }));

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
      fallback = JSON.parse(localStorage.getItem('outbox_v1') || '[]');

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

    return new Set(old.concat(fallback).map(function (job) {
      return job.id;
    })).size;
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
      this.handshakePromise = null;
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
      this.clockWarning = '';
      this.clockState = null;

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
        const config = this.config();
        return !!config.url && !!config.token;
      } catch (error) {
        return false;
      }
    }

    latestSupported() {
      const features = this.state.snapshot && this.state.snapshot.features;

      return !!(
        features &&
        features.latestOps === true &&
        features.latestOpsProtocol === LATEST_PROTOCOL
      );
    }

    latestVerified() {
      const config = this.config();

      return this.verifiedConnection === config.url + '\n' + config.token &&
        this.verifiedFeatures.latestOps === true &&
        this.verifiedFeatures.latestOpsProtocol === LATEST_PROTOCOL &&
        !!this.clockState &&
        this.clockState.samples.length > 0;
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

    notifyWishes() {
      if (!('BroadcastChannel' in window)) {
        return;
      }

      try {
        const channel = new BroadcastChannel(WISH_CHANNEL);
        channel.postMessage('changed');
        channel.close();
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
      const names = {
        waiting: '通信の順番待ち',
        reading: '更新中',
        retrying: '一覧を取り直しています',
        failed: '前回の更新に失敗',
        deferred: '更新待ち'
      };

      if (this.readStatus.phase === 'success') {
        return this.readStatus.attempt === 2
          ? '再取得で更新成功'
          : '更新成功';
      }

      return names[this.readStatus.phase] || 'この起動後は未確認';
    }

    clockStatusLabel() {
      if (this.clockWarning) {
        return this.clockWarning;
      }

      return this.clockState && this.clockState.samples.length
        ? 'サーバー時刻で補正済み（概算）'
        : '初回通信後に補正';
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
          '端末の保存先が変更されました。入力途中の内容は消さないでください。'
        );
      };

      this.state = await this.readState();
      this.legacyCount = await oldPendingCount();
      await this.loadClock();

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

            this.emit(
              event.data && event.data.meta
                ? event.data.meta
                : {
                  kind: 'state'
                }
            );

            this.pump(false);
          } catch (error) {
            this.issue('端末の記録を読み取れません', error.message);
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
          this.lastHiddenDuration = Math.max(0, Date.now() - this.hiddenAt);
          this.hiddenAt = 0;
        }
      });

      window.addEventListener('pagehide', () => {
        this.paused = true;
        this.cancelRead('pagehide');

        if (this.channel) {
          try {
            this.channel.postMessage({
              type: 'wake'
            });
          } catch (error) {
            console.error(error);
          }
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
          this.ready &&
          !this.paused &&
          (!this.channel || this.state.jobs.length)
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

      const next = await this.readState();
      const changed = next.savedAt !== this.state.savedAt;
      this.state = next;

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

    loadClock() {
      return new Promise((resolve, reject) => {
        const transaction = this.db.transaction('data', 'readonly');
        const request = transaction.objectStore('data').get(CLOCK_KEY);

        transaction.oncomplete = () => {
          try {
            this.clockState = checkedClock(request.result);
            resolve(this.clockState);
          } catch (error) {
            reject(error);
          }
        };

        transaction.onerror = transaction.onabort = function () {
          reject(
            transaction.error ||
            new Error('操作順の記録を読み取れませんでした。')
          );
        };
      });
    }

    updateClock(change) {
      return new Promise((resolve, reject) => {
        const transaction = this.db.transaction('data', 'readwrite');
        const store = transaction.objectStore('data');
        const request = store.get(CLOCK_KEY);

        let clock;
        let output;
        let caught;

        request.onsuccess = function () {
          try {
            clock = checkedClock(request.result);
            output = change(clock);
            store.put(clock, CLOCK_KEY);
          } catch (error) {
            caught = error;
            transaction.abort();
          }
        };

        transaction.oncomplete = () => {
          this.clockState = clock;
          resolve(output);
        };

        transaction.onerror = transaction.onabort = function () {
          reject(
            caught ||
            transaction.error ||
            new Error('操作順を端末に保存できませんでした。')
          );
        };
      });
    }

    async recordClockSample(serverTime, started, received, serverMs) {
      if (
        !Number.isSafeInteger(serverTime) ||
        serverTime <= 0 ||
        received < started
      ) {
        return;
      }

      const roundTrip = received - started;
      const work = Number.isFinite(serverMs) ? Math.max(0, serverMs) : 0;
      const transport = Math.max(0, roundTrip - work);
      const offset = serverTime + transport / 2 - received;

      try {
        await this.updateClock(function (clock) {
          clock.samples.push({
            localAt: received,
            offset: offset,
            roundTrip: roundTrip
          });

          clock.samples = clock.samples.slice(-CLOCK_SAMPLE_LIMIT);
        });

        this.clockWarning = '';
      } catch (error) {
        this.clockWarning = '時刻補正の記録を保存できませんでした';
      }
    }

    createOperationOrder(id, createdAt) {
      return this.updateClock(function (clock) {
        if (clock.sequence >= Number.MAX_SAFE_INTEGER - 1) {
          throw new Error('操作順の記録を確認してください。');
        }

        clock.sequence++;
        const sample = sampleFor(clock, createdAt);
        let at = null;

        if (sample) {
          at = Math.max(
            Math.round(createdAt + sample.offset),
            clock.lastNewAt + 1
          );

          clock.lastNewAt = at;
        }

        return {
          protocol: LATEST_PROTOCOL,
          requestId: id,
          actor: clock.actor,
          sequence: clock.sequence,
          at: at,
          createdAt: createdAt,
          sealed: false
        };
      });
    }

    operationOrderFor(payload) {
      const key = WISH_ACTIONS.indexOf(payload.action) >= 0
        ? 'wishes-v1'
        : 'main';

      const id = String(payload.requestId || '');

      return new Promise((resolve, reject) => {
        const transaction = this.db.transaction('data', 'readwrite');
        const store = transaction.objectStore('data');
        const getState = store.get(key);
        const getClock = store.get(CLOCK_KEY);

        let stateReady = false;
        let clockReady = false;
        let output;
        let nextClock;
        let caught;

        function prepare() {
          if (!stateReady || !clockReady) {
            return;
          }

          try {
            const saved = getState.result;

            if (!saved || !Array.isArray(saved.jobs)) {
              throw new Error('送信する操作の端末記録を確認できません。');
            }

            const job = saved.jobs.find(function (entry) {
              return entry.id === id;
            });

            if (!job || String(job.payload.requestId || '') !== id) {
              throw new Error('送信する操作が端末の記録に見つかりません。');
            }

            nextClock = checkedClock(getClock.result);
            let order = job.operationOrder;

            if (order && order.sealed === true) {
              if (!validOrder(order, id)) {
                throw new Error('送信済み操作の順序情報を読み取れません。');
              }

              output = clone(order);
              return;
            }

            if (!order) {
              if (nextClock.sequence >= Number.MAX_SAFE_INTEGER - 1) {
                throw new Error('操作順の記録を確認してください。');
              }

              nextClock.sequence++;

              order = {
                protocol: LATEST_PROTOCOL,
                requestId: id,
                actor: nextClock.actor,
                sequence: nextClock.sequence,
                at: null,
                createdAt: Number.isFinite(job.createdAt)
                  ? job.createdAt
                  : Date.now(),
                sealed: false
              };
            }

            if (
              order.protocol !== LATEST_PROTOCOL ||
              order.requestId !== id ||
              typeof order.actor !== 'string' ||
              !Number.isSafeInteger(order.sequence)
            ) {
              throw new Error('操作順の記録を読み取れません。');
            }

            if (!Number.isSafeInteger(order.at) || order.at <= 0) {
              const when = Number.isFinite(order.createdAt)
                ? order.createdAt
                : job.createdAt;

              const sample = sampleFor(nextClock, when);

              if (!sample || !Number.isFinite(when)) {
                throw new Error('操作時刻を補正できません。通信できる状態で更新してください。');
              }

              // 古い送信待ちを、現在の時刻へ付け替えない。
              order.at = Math.max(1, Math.round(when + sample.offset));
            }

            order.sealed = true;

            if (!validOrder(order, id)) {
              throw new Error('操作順を確定できませんでした。');
            }

            job.operationOrder = clone(order);
            saved.savedAt = Date.now();
            store.put(saved, key);
            store.put(nextClock, CLOCK_KEY);
            output = clone(order);
          } catch (error) {
            caught = error;
            transaction.abort();
          }
        }

        getState.onsuccess = function () {
          stateReady = true;
          prepare();
        };

        getClock.onsuccess = function () {
          clockReady = true;
          prepare();
        };

        transaction.oncomplete = () => {
          if (nextClock) {
            this.clockState = nextClock;
          }

          resolve(output);
        };

        transaction.onerror = transaction.onabort = function () {
          reject(
            caught ||
            transaction.error ||
            new Error('操作順を端末に保存できませんでした。')
          );
        };
      });
    }

    async rearmAutomaticConflicts() {
      if (!this.latestSupported() || this.legacyCount) {
        return false;
      }

      const result = await new Promise((resolve, reject) => {
        const transaction = this.db.transaction('data', 'readwrite');
        const store = transaction.objectStore('data');
        const mainRequest = store.get('main');
        const wishRequest = store.get('wishes-v1');

        let mainReady = false;
        let wishReady = false;
        let main;
        let mainChanged = false;
        let wishChanged = false;
        let caught;

        function rearm(saved, actions) {
          if (!saved || !Array.isArray(saved.jobs)) {
            return false;
          }

          let changed = false;

          saved.jobs.forEach(function (job) {
            if (
              job.state === 'conflict' &&
              actions.indexOf(job.payload.action) >= 0 &&
              job.latestRechecked !== LATEST_PROTOCOL
            ) {
              job.latestRechecked = LATEST_PROTOCOL;
              job.state = 'saved';
              job.retryAt = 0;
              job.shortRetry = 0;
              job.errorStatus = '';
              job.note = '';
              changed = true;
            }
          });

          if (changed) {
            saved.savedAt = Date.now();
          }

          return changed;
        }

        function finishPreparation() {
          if (!mainReady || !wishReady) {
            return;
          }

          try {
            main = checkedState(mainRequest.result);
            mainChanged = rearm(main, TASK_ACTIONS);

            if (mainChanged) {
              store.put(main, 'main');
            }

            const wishes = wishRequest.result;

            if (wishes != null && !Array.isArray(wishes.jobs)) {
              throw new Error('「したいこと」の端末記録を読み取れません。');
            }

            wishChanged = rearm(wishes, WISH_ACTIONS);

            if (wishChanged) {
              store.put(wishes, 'wishes-v1');
            }
          } catch (error) {
            caught = error;
            transaction.abort();
          }
        }

        mainRequest.onsuccess = function () {
          mainReady = true;
          finishPreparation();
        };

        wishRequest.onsuccess = function () {
          wishReady = true;
          finishPreparation();
        };

        transaction.oncomplete = function () {
          resolve({
            main: main,
            mainChanged: mainChanged,
            wishChanged: wishChanged
          });
        };

        transaction.onerror = transaction.onabort = function () {
          reject(
            caught ||
            transaction.error ||
            new Error('未送信の再確認を準備できませんでした。')
          );
        };
      });

      if (result.mainChanged) {
        this.state = result.main;
        this.signal({
          kind: 'state'
        });
      }

      if (result.wishChanged) {
        this.notifyWishes();
      }

      return result.mainChanged || result.wishChanged;
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
        this.diagnosticWarning = '通信の点検記録を端末に保存できませんでした。';
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
        '照合番号は、タスクID・保存操作の受付番号とは別です。'
      ];

      if (!this.readTraces.length) {
        lines.push('記録：なし');
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
      const outcomes = {
        retrying: '再確認開始・終了結果は未記録',
        recovered: '再確認で成功',
        failed: '失敗',
        interrupted: '再確認を中断'
      };

      const codes = {
        'non-json': 'JSONではない返答',
        'response-envelope': '返答全体の形式不一致',
        'server-version': '保存先の対応確認が必要',
        'entry-guide': '一覧ではなく入口の案内',
        'snapshot-shape': 'タスク一覧の形式不一致',
        'unchanged-shape': '変更なしの返答の形式不一致',
        'read-extra-shape': '画面別情報の形式不一致',
        'mutation-receipt-shape': '保存結果の確認情報が不足',
        'trace-mismatch': '照合番号が不一致',
        'cached-list-mismatch': '端末の一覧と返答を照合できない',
        'server-rejection': '保存先が要求を受け付けなかった',
        'http': '応答番号が正常ではない',
        'network': '接続失敗',
        'timeout': '応答待ち時間超過',
        'interrupted': '通信中断',
        'other': '通信または端末保存の処理で失敗'
      };

      const lines = [
        '通信の点検の版：' + BUILD,
        '操作時刻の補正：' + this.clockStatusLabel(),
        '【異常な返答の記録】'
      ];

      if (this.diagnosticWarning) {
        lines.push(this.diagnosticWarning);
      }

      const records = this.readDiagnostics.slice().reverse();

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
          '結果：' + (outcomes[record.outcome] || '未確定')
        );

        if (record.traceId) {
          lines.push('読み取り照合番号：' + record.traceId);
        }

        (record.attempts || []).forEach(function (attempt) {
          const info = attempt.response || {};

          lines.push(
            '・' + attempt.number + '回目' +
              '／全体取得要求：' + (attempt.full ? 'あり' : 'なし') +
              '／' + (attempt.accepted ? '受理' : '不受理'),
            '  判定：' + (
              attempt.accepted
                ? '必要な情報を確認'
                : codes[attempt.code] || 'その他'
            ),
            '  返答種別：' + (info.format || '未確認'),
            '  応答番号：' + (
              info.httpStatus == null ? '未取得' : info.httpStatus
            ),
            '  Content-Type：' + (info.contentType || 'なし'),
            '  転送：' + (
              typeof info.redirected === 'boolean'
                ? info.redirected ? 'あり' : 'なし'
                : '未記録または確認できない'
            ),
            '  最終到着先：' + (info.finalDestination || '未記録'),
            '  入口案内との一致：' + (
              typeof info.entryGuide === 'boolean'
                ? info.entryGuide ? '一致' : '一致しない'
                : '未記録または判定できない'
            ),
            '  試行時間：' + (
              Number.isFinite(info.elapsedMs)
                ? info.elapsedMs + 'ミリ秒'
                : '未記録'
            ),
            '  ok：' + (
              typeof info.ok === 'boolean' ? String(info.ok) : 'なし'
            ),
            '  status：' + (info.status || 'なし'),
            '  app：' + (info.app || 'なし'),
            '  build：' + (info.build || 'なし'),
            '  unchanged：' + String(info.unchanged === true)
          );

          if (attempt.number > 1 && Number.isFinite(attempt.waitMs)) {
            lines.push('  再確認前の待ち：' + attempt.waitMs + 'ミリ秒');
          }

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

          if (
            saved &&
            saved.owner !== this.id &&
            saved.until > now &&
            !(webLock && saved.method === 'web-lock-v1')
          ) {
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
            function (lock) {
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

    async ensureLatestConnection() {
      if (this.latestVerified()) {
        return;
      }

      if (this.handshakePromise) {
        return this.handshakePromise;
      }

      this.handshakePromise = (async () => {
        const result = await this.rawRequest({
          action: 'load'
        }, true);

        validateReadResponse('load', result, true);
        await this.acceptRead(result);

        if (!this.latestVerified()) {
          throw receiveError(
            'server-version',
            '保存先の自動反映機能を確認できません。コード.gsと変更順.gsのv4.12.1を同じ公開先へ反映してください。',
            result[RESPONSE_INFO],
            false
          );
        }
      })().finally(() => {
        this.handshakePromise = null;
      });

      return this.handshakePromise;
    }

    async request(payload, forceFull, operation) {
      let order = null;

      if (WRITE_ACTIONS.indexOf(payload.action) >= 0) {
        await this.ensureLatestConnection();
        order = await this.operationOrderFor(payload);
      }

      return this.rawRequest(payload, forceFull, operation, order);
    }

    async rawRequest(payload, forceFull, operation, order) {
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

      if (order) {
        hint.operationOrder = {
          protocol: order.protocol,
          requestId: order.requestId,
          at: order.at,
          actor: order.actor,
          sequence: order.sequence
        };
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
          const error = receiveError(
            'http',
            '保存先から正常な返答を受け取れませんでした' +
              '（応答番号：' + response.status + '）。',
            summarizeResponse(undefined, transport),
            response.status === 404 &&
              READ_ACTIONS.indexOf(payload.action) >= 0,
            [],
            response.status === 404 ? READ_RETRY_DELAY_MS : 0
          );

          error.httpStatus = response.status;
          throw error;
        }

        const text = await response.text();
        const received = Date.now();
        transport.elapsedMs = Math.max(0, received - started);

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
            true
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

        if (result.app === SERVER_VERSION && !isEntryGuide(result)) {
          const source = result.snapshot || result.patch || result;

          if (source.features) {
            this.verifiedFeatures = source.features;
          }

          if (result.ok) {
            this.verifiedConnection = config.url + '\n' + config.token;
          }

          await this.recordClockSample(
            result.serverTime,
            started,
            received,
            result.serverMs
          );
        }

        Object.defineProperty(result, RESPONSE_INFO, {
          value: info,
          enumerable: false
        });

        this.lastCommunication = {
          action: payload.action,
          milliseconds: transport.elapsedMs,
          serverMs: Number.isFinite(result.serverMs) ? result.serverMs : null
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
      if (clearReadError) {
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

          if (
            Date.parse(result.fetchedAt) >=
            Date.parse(saved.snapshot.fetchedAt || '')
          ) {
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

      if (accepted && this.latestSupported()) {
        await this.rearmAutomaticConflicts();
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

          if (waitMs) {
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

            if (!await this.acceptRead(response, operation)) {
              throw receiveError(
                'cached-list-mismatch',
                '端末の一覧と、保存先の返答を照合できませんでした。',
                response[RESPONSE_INFO],
                true
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
            this.setReadStatus('deferred', payload.action, attempt, operation);

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

          const recorded = attemptRecord || {
            number: attempt,
            full: full,
            waitMs: waitMs,
            queueMs: null,
            sentAt: '',
            accepted: false,
            issues: []
          };

          recorded.code = error.receiveCode || 'other';
          recorded.response = error.receiveInfo ||
            (
              response
                ? response[RESPONSE_INFO] || summarizeResponse(response)
                : summarizeResponse(undefined)
            );

          recorded.issues = error.receiveIssues || [];

          if (!attemptRecord) {
            operation.attempts.push(recorded);
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

          diagnostic.attempts.push(clone(recorded));

          if (attempt === 1 && error.retryFull === true) {
            diagnostic.outcome = 'retrying';
            await this.saveReadDiagnostic(diagnostic);
            full = true;
            waitMs = Math.max(
              READ_RETRY_DELAY_MS,
              error.retryAfterMs || 0
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
      const createdAt = Date.now();
      const operationOrder = await this.createOperationOrder(id, createdAt);

      await this.mutate(function (saved) {
        if (
          payload.action === 'automatic' &&
          saved.jobs.some(function (job) {
            return job.payload.action === 'automatic';
          })
        ) {
          throw new Error(
            '自動追加の変更が送信待ちです。保存結果を確認してください。'
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
          operationOrder: operationOrder,
          label: label,
          keys: context.keys,
          causes: context.causes,
          state: 'saved',
          frozen: false,
          note: '',
          createdAt: createdAt,
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
          serverMs: Number.isFinite(result.serverMs) ? result.serverMs : null,
          outcome: safeOutcome(result.result && result.result.latestOutcome),
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
        throw new Error('処理後の一覧を確認できませんでした。');
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

          if (job.serverReceipt) {
            result = await this.finishConfirmedMutation(job, started, null);
          } else {
            result = await this.request(job.payload, false);

            if (result.ok) {
              await this.rememberMutationReceipt(job, result);
              result = await this.finishConfirmedMutation(job, started, result);
            } else {
              const blocked =
                result.status === 'invalid' ||
                result.status === 'indeterminate';

              if (blocked) {
                await this.mutate(function (saved) {
                  const current = saved.jobs.find(function (entry) {
                    return entry.id === job.id;
                  });

                  if (current) {
                    current.state = 'blocked';
                    current.note = result.message || '保存先の確認が必要です。';
                    current.retryAt = 0;
                    current.shortRetry = 0;
                    current.errorStatus = result.status;
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
                result.status === 'conflict'
                  ? '自動反映の確認を得られませんでした。保存先と各端末の版を確認してください。'
                  : result.message || '保存結果を確認できませんでした。',
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

          if (this.options.onSaved) {
            try {
              this.options.onSaved(job, result);
            } catch (error) {
              console.error(error);
            }
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

        if (!current || current.state === 'blocked') {
          return;
        }

        current.attempts = (current.attempts || 0) + 1;
        current.shortRetry = 0;

        const settingsError =
          finalError.serverStatus === 'denied' ||
          finalError.serverStatus === 'needs_setup' ||
          finalError.receiveCode === 'server-version';

        const protocolError = finalError.serverStatus === 'conflict';

        const delay = settingsError
          ? 300000
          : protocolError
            ? 60000
            : Math.min(
              300000,
              5000 * Math.pow(2, Math.min(current.attempts - 1, 6))
            );

        current.state = 'unknown';
        current.errorStatus = settingsError ? 'settings' : '';
        current.retryAt = Date.now() + delay;

        current.note = String(finalError.message || finalError) +
          (
            current.serverReceipt
              ? '\n保存先の処理結果は確認しています。更新要求ではなく一覧を確認します。'
              : '\n同じ受付番号・同じ操作順・同じ更新内容で再確認します。'
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
              '\nデータは消さずに確認してください。'
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

        const receiptOutcome = job.serverReceipt &&
          job.serverReceipt.result &&
          job.serverReceipt.result.latestOutcome;

        if (
          receiptOutcome &&
          ['superseded', 'baseline', 'completed', 'expired', 'merged']
            .indexOf(receiptOutcome) >= 0
        ) {
          return;
        }

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
              pendingText: job.state === 'blocked'
                ? '確認が必要'
                : job.state === 'sending'
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

            task.blocked = task.blocked || job.state === 'blocked';
          }
        }

        if (payload.action === 'planMove') {
          const task = tasks.find(function (entry) {
            return entry.taskId === payload.taskId;
          });

          if (task) {
            const previousDate = task.date;
            task.date = payload.date;

            if (payload.date) {
              task.hour = payload.hour;
            }

            task.pendingPlanning = true;
            task.blocked = task.blocked || job.state === 'blocked';
            task.pendingText = job.state === 'blocked'
              ? '確認が必要'
              : job.state === 'sending'
                ? '保存結果を確認中'
                : '送信待ち';

            if (previousDate && previousDate !== task.date) {
              tasks.filter(function (entry) {
                return entry.date === previousDate && !entry.localOnly;
              }).sort(compareTasks).forEach(function (entry, index) {
                entry.order = index + 1;
              });
            }

            if (payload.date) {
              const current = new Map(tasks.map(function (entry) {
                return [entry.taskId, entry];
              }));

              const items = (payload.items || []).map(function (item) {
                const actual = current.get(item.id);

                return {
                  id: item.id,
                  hour: item.id === task.taskId
                    ? task.hour
                    : actual ? actual.hour : item.hour
                };
              });

              mergePlan(items, tasks, payload.date).forEach(function (item, index) {
                const actual = current.get(item.id);

                if (actual) {
                  actual.order = index + 1;
                }
              });
            }
          }
        }

        if (payload.action === 'order') {
          const byId = new Map(tasks.map(function (task) {
            return [task.taskId, task];
          }));

          const moving = payload.movedTaskId
            ? byId.get(payload.movedTaskId)
            : null;

          if (moving && moving.date === payload.date) {
            const desired = (payload.items || []).find(function (item) {
              return item.id === moving.taskId;
            });

            if (
              desired &&
              (
                !Object.prototype.hasOwnProperty.call(payload, 'fromHour') ||
                desired.hour !== payload.fromHour
              )
            ) {
              moving.hour = desired.hour;
            }

            moving.pendingPlanning = true;
            moving.blocked = moving.blocked || job.state === 'blocked';
            moving.pendingText = job.state === 'sending'
              ? '保存結果を確認中'
              : '送信待ち';
          }

          const items = payload.movedTaskId
            ? (payload.items || []).map(function (item) {
              const actual = byId.get(item.id);

              return {
                id: item.id,
                hour: actual ? actual.hour : item.hour
              };
            })
            : payload.items;

          mergePlan(items, tasks, payload.date).forEach(function (item, index) {
            const task = byId.get(item.id);

            if (task) {
              if (!payload.movedTaskId) {
                task.hour = item.hour;
              }

              task.order = index + 1;
            }
          });
        }
      });

      return tasks;
    }
  }

  window.TaskCore = {
    VERSION: VERSION,
    BUILD: BUILD,
    EDIT_PROTOCOL: EDIT_PROTOCOL,
    PLAN_PROTOCOL: PLAN_PROTOCOL,
    LATEST_PROTOCOL: LATEST_PROTOCOL,
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
    editFields: editFieldsFor,
    actionLabel: actionLabel,
    outcomeLabel: outcomeLabel
  };
})();
