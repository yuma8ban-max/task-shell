// File: wish-client.js
(function () {
  'use strict';

  const VERSION = 'v4.9';
  const STORAGE_KEY = 'wishes-v1';
  const CHANNEL_NAME = 'task-wishes-v1';

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
      savedAt: 0,
      lastNetworkAt: 0
    };
  }

  function checkedState(value) {
    if (value == null) {
      return emptyState();
    }

    if (
      !Array.isArray(value.jobs) ||
      !Number.isSafeInteger(value.sequence)
    ) {
      throw new Error(
        '「したいこと」の端末記録を読み取れません。データは消さないでください。'
      );
    }

    return value;
  }

  function requireSnapshot(snapshot) {
    if (
      !snapshot ||
      !Array.isArray(snapshot.items) ||
      typeof snapshot.revision !== 'string'
    ) {
      throw new Error('「したいこと」の一覧を読み取れませんでした。');
    }
  }

  function storeSnapshot(saved, snapshot) {
    requireSnapshot(snapshot);

    const previous = saved.snapshot
      ? Date.parse(saved.snapshot.fetchedAt || '')
      : NaN;

    const incoming = Date.parse(snapshot.fetchedAt || '');

    if (
      Number.isFinite(previous) &&
      Number.isFinite(incoming) &&
      incoming < previous
    ) {
      return;
    }

    saved.snapshot = snapshot;
  }

  function readyJob(saved, force) {
    const now = Date.now();

    return saved.jobs.slice().sort(function (a, b) {
      return a.sequence - b.sequence;
    }).find(function (job) {
      return ['saved', 'sending', 'unknown'].indexOf(job.state) >= 0 &&
        (force || !job.retryAt || job.retryAt <= now);
    });
  }

  class WishClient {
    constructor(options) {
      this.options = options;
      this.transport = options.transport;
      this.state = emptyState();
      this.ready = false;
      this.channel = null;
      this.pumpPromise = null;
      this.readPromise = null;
      this.lastError = '';
    }

    emit() {
      try {
        if (this.options.onChange) {
          this.options.onChange();
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

    async start() {
      if (!this.transport.ready) {
        throw new Error('端末保存の準備ができていません。');
      }

      this.state = await this.readState();
      this.ready = true;

      if ('BroadcastChannel' in window) {
        this.channel = new BroadcastChannel(CHANNEL_NAME);

        this.channel.onmessage = async () => {
          if (this.transport.paused) {
            return;
          }

          try {
            await this.reloadLocal();
            this.pump(false);
          } catch (error) {
            this.issue('「したいこと」を読み取れません', error.message);
          }
        };
      }

      window.addEventListener('online', () => {
        this.reloadLocal().then(() => {
          this.pump(true);
        }).catch((error) => {
          this.issue('「したいこと」を読み取れません', error.message);
        });
      });

      window.addEventListener('pageshow', (event) => {
        if (event.persisted) {
          this.reloadLocal().then(() => {
            this.pump(false);
          }).catch((error) => {
            this.issue('「したいこと」を読み取れません', error.message);
          });
        }
      });

      setInterval(() => {
        if (
          this.ready &&
          !this.transport.paused &&
          (this.state.jobs.length || !this.channel)
        ) {
          this.reloadLocal().then(() => {
            this.pump(false);
          }).catch((error) => {
            this.issue('「したいこと」を読み取れません', error.message);
          });
        }
      }, 2000);

      this.emit();
      this.pump(false);
      return this;
    }

    readState() {
      return new Promise((resolve, reject) => {
        const transaction = this.transport.db.transaction('data', 'readonly');
        const request = transaction.objectStore('data').get(STORAGE_KEY);

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
      if (!this.ready || this.transport.paused) {
        return;
      }

      const next = await this.readState();
      const changed = next.savedAt !== this.state.savedAt;
      this.state = next;

      if (changed) {
        this.emit();
      }
    }

    mutate(change) {
      return new Promise((resolve, reject) => {
        const transaction = this.transport.db.transaction('data', 'readwrite');
        const store = transaction.objectStore('data');
        const request = store.get(STORAGE_KEY);

        let next;
        let output;
        let caught;

        request.onsuccess = function () {
          try {
            next = checkedState(request.result);
            output = change(next);
            next.savedAt = Date.now();
            store.put(next, STORAGE_KEY);
          } catch (error) {
            caught = error;
            transaction.abort();
          }
        };

        transaction.oncomplete = () => {
          this.state = next;
          resolve(output);
          this.emit();

          if (this.channel) {
            try {
              this.channel.postMessage('changed');
            } catch (error) {
              console.error(error);
            }
          }
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

    async read(background) {
      if (this.readPromise) {
        return this.readPromise;
      }

      if (!this.ready || this.transport.legacyCount) {
        throw new Error('端末保存の準備ができていません。');
      }

      this.readPromise = this.transport.withNetwork(async () => {
        this.state = await this.readState();

        if (
          background &&
          Date.now() - this.state.lastNetworkAt < 20000
        ) {
          return null;
        }

        const result = await this.transport.request({
          action: 'wishList'
        });

        if (!result.ok) {
          throw new Error(result.message || '一覧を取得できませんでした。');
        }

        requireSnapshot(result.wishSnapshot);

        await this.mutate(function (saved) {
          storeSnapshot(saved, result.wishSnapshot);
          saved.lastNetworkAt = Date.now();
        });

        this.lastError = '';
        return result;
      }, {
        opportunistic: !!background
      }).then(function (result) {
        return typeof result === 'symbol' ? null : result;
      }).catch((error) => {
        if (!this.transport.paused) {
          this.lastError = String(error.message || error);
        }

        throw error;
      }).finally(() => {
        this.readPromise = null;
        this.emit();
      });

      this.emit();
      return this.readPromise;
    }

    async enqueue(payload, label) {
      if (!this.ready || this.transport.legacyCount) {
        throw new Error('端末保存の準備ができていません。');
      }

      const id = uuid();

      await this.mutate(function (saved) {
        if (
          payload.wishId &&
          saved.jobs.some(function (job) {
            return job.payload.wishId === payload.wishId;
          })
        ) {
          throw new Error('この項目の送信結果を確認中です。');
        }

        saved.sequence++;

        saved.jobs.push({
          id: id,
          sequence: saved.sequence,
          createdAt: Date.now(),
          payload: Object.assign({}, clone(payload), {
            requestId: id
          }),
          label: label,
          state: 'saved',
          note: '',
          retryAt: 0,
          attempts: 0
        });
      });

      this.pump(false);
      return id;
    }

    add(title) {
      return this.enqueue({
        action: 'wishAdd',
        title: title
      }, 'したいこと：' + title);
    }

    setDone(item, done) {
      const original = this.state.snapshot &&
        this.state.snapshot.items.find(function (entry) {
          return entry.wishId === item.wishId;
        });

      if (!original) {
        return Promise.reject(
          new Error('送信結果の確認後に操作してください。')
        );
      }

      return this.enqueue({
        action: done ? 'wishDone' : 'wishRestore',
        wishId: original.wishId,
        expectedWish: original.version
      }, (done ? '達成：' : '戻す：') + original.title);
    }

    effectiveItems() {
      const map = new Map(
        (this.state.snapshot ? this.state.snapshot.items : [])
          .map(function (item) {
            return [item.wishId, clone(item)];
          })
      );

      this.state.jobs.slice().sort(function (a, b) {
        return a.sequence - b.sequence;
      }).forEach(function (job) {
        const payload = job.payload;

        if (payload.action === 'wishAdd') {
          if (!map.has(job.id)) {
            map.set(job.id, {
              wishId: job.id,
              title: payload.title,
              done: false,
              createdAt: job.createdAt,
              updatedAt: job.createdAt,
              doneAt: 0,
              row: 1000000000 + job.sequence,
              localOnly: true
            });
          }

          map.get(job.id).pending = true;
          map.get(job.id).jobId = job.id;
        } else {
          const item = map.get(payload.wishId);

          if (item) {
            item.done = payload.action === 'wishDone';
            item.doneAt = item.done ? job.createdAt : 0;
            item.pending = true;
            item.jobId = job.id;
          }
        }
      });

      return Array.from(map.values());
    }

    pump(force) {
      if (this.pumpPromise) {
        return this.pumpPromise;
      }

      if (
        !this.ready ||
        this.transport.legacyCount ||
        this.transport.paused ||
        !navigator.onLine ||
        !this.transport.configured() ||
        !readyJob(this.state, !!force)
      ) {
        return Promise.resolve(false);
      }

      this.pumpPromise = (async () => {
        let changed = false;
        let allowForce = !!force;

        while (
          !this.transport.paused &&
          navigator.onLine &&
          this.transport.configured()
        ) {
          this.state = await this.readState();

          if (!readyJob(this.state, allowForce)) {
            break;
          }

          const step = await this.transport.withNetwork(
            () => this.sendOne(allowForce),
            {
              write: true
            }
          );

          allowForce = false;

          if (typeof step === 'symbol' || !step) {
            break;
          }

          if (step.saved) {
            changed = true;
          }

          if (step.stop) {
            break;
          }
        }

        return changed;
      })().catch((error) => {
        if (!this.transport.paused) {
          this.issue(
            '「したいこと」の保存を確認できません',
            String(error.message || error)
          );
        }

        return false;
      }).finally(() => {
        this.pumpPromise = null;
        this.emit();
      });

      return this.pumpPromise;
    }

    async sendOne(force) {
      let job = null;

      await this.mutate(function (saved) {
        const current = readyJob(saved, force);

        if (!current) {
          return;
        }

        current.state = 'sending';
        current.note = '';
        current.retryAt = 0;
        job = clone(current);
      });

      if (!job) {
        return {
          stop: true
        };
      }

      try {
        const result = await this.transport.request(job.payload);

        if (result.ok) {
          requireSnapshot(result.wishSnapshot);

          await this.mutate(function (saved) {
            storeSnapshot(saved, result.wishSnapshot);
            saved.jobs = saved.jobs.filter(function (entry) {
              return entry.id !== job.id;
            });
            saved.lastNetworkAt = Date.now();
          });

          this.lastError = '';

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
            }

            if (result.wishSnapshot) {
              storeSnapshot(saved, result.wishSnapshot);
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
        if (this.transport.paused) {
          throw error;
        }

        await this.mutate(function (saved) {
          const current = saved.jobs.find(function (entry) {
            return entry.id === job.id;
          });

          if (!current) {
            return;
          }

          current.attempts = (current.attempts || 0) + 1;
          current.state = 'unknown';
          current.retryAt = Date.now() + Math.min(
            300000,
            5000 * Math.pow(2, Math.min(current.attempts - 1, 6))
          );

          current.note =
            String(error.message || error) +
            '\n同じ受付番号で再確認します。';
        });

        return {
          saved: false,
          stop: true
        };
      }
    }

    async resolveConflict(id, useLocal, reviewedVersion) {
      await this.mutate(function (saved) {
        const index = saved.jobs.findIndex(function (job) {
          return job.id === id && job.state === 'conflict';
        });

        if (index < 0) {
          return;
        }

        if (!useLocal) {
          saved.jobs.splice(index, 1);
          return;
        }

        const job = saved.jobs[index];

        const item = saved.snapshot &&
          saved.snapshot.items.find(function (entry) {
            return entry.wishId === job.payload.wishId;
          });

        if (!item || item.version !== reviewedVersion) {
          throw new Error('内容が変わりました。確認画面を開き直してください。');
        }

        const newId = uuid();
        job.id = newId;
        job.payload.requestId = newId;
        job.payload.expectedWish = item.version;
        job.state = 'saved';
        job.note = '';
        job.retryAt = 0;
        job.attempts = 0;
      });

      this.pump(false);
    }
  }

  window.WishClient = {
    VERSION: VERSION,
    create: function (options) {
      return new WishClient(options);
    }
  };
})();
