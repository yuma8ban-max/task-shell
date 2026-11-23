/* File: order-list.js — 並べ替えの部品（実行中・今日の順番・今日の画面の3つで共有）
 *
 * 並びは下書きで持ち、「保存」で onSave(ids) を呼ぶ。操作：ドラッグ・「上へ／下へ」・キー
 * （↓/J・↑/K で選ぶ、Alt+↑/↓ で動かす、Enter で保存）。group が同じ行の間だけ動かせる。
 */
(function () {
  'use strict';

  const STYLE = [
    '.ol-list{margin:0;padding:0;list-style:none}',
    '.ol-row{display:flex;align-items:center;gap:8px;margin:6px 0;padding:10px;border:1px solid #d8dfe6;border-radius:10px;background:#fff;color:#202833}',
    '.ol-row.is-selected{border-color:#1a73e8;background:#f3f8ff}',
    '.ol-row.is-dragging{opacity:.55;border-color:#1a73e8}',
    '.ol-row.is-locked{background:#f6f8fb}',
    '.ol-grip{flex:none;width:36px;height:36px;border:0;border-radius:8px;background:transparent;color:#697582;font-size:18px;line-height:1;cursor:grab;touch-action:none}',
    '.ol-grip:disabled{cursor:default;opacity:.4}',
    '.ol-no{flex:none;min-width:1.6em;color:#697582;font-size:14px;text-align:right;font-variant-numeric:tabular-nums}',
    '.ol-body{flex:1;min-width:0;overflow-wrap:anywhere}',
    '.ol-time{flex:none;color:#46576a;font-size:14px}',
    '.ol-move{flex:none;display:flex;gap:4px}',
    '.ol-move button,.ol-actions button,.ol-ask button{min-height:36px;padding:0 12px;border:1px solid #c5cfdb;border-radius:8px;background:#fff;color:#202833;font:inherit;font-size:14px;cursor:pointer}',
    '.ol-move button:disabled,.ol-actions button:disabled{opacity:.45;cursor:default}',
    '.ol-actions{display:flex;gap:8px;margin:10px 0}',
    '.ol-actions .ol-save,.ol-ask .ol-primary{border-color:#1a73e8;background:#1a73e8;color:#fff}',
    '.ol-empty{margin:10px 0;color:#46576a;font-size:16px}',
    '.ol-ask{width:min(92vw,420px);padding:18px;border:1px solid #c5cfdb;border-radius:12px;color:#202833}',
    '.ol-ask h2{margin:0 0 14px;font-size:16px}',
    '.ol-ask .ol-choices{display:flex;flex-wrap:wrap;gap:8px}',
    '.ol-live{position:absolute;left:-9999px}'
  ].join('\n');

  function injectStyle() {
    if (document.getElementById('order-list-style')) {
      return;
    }

    const style = document.createElement('style');
    style.id = 'order-list-style';
    style.textContent = STYLE;
    document.head.appendChild(style);
  }

  function make(tag, text, className) {
    const node = document.createElement(tag);

    if (text != null) {
      node.textContent = text;
    }

    if (className) {
      node.className = className;
    }

    return node;
  }

  function same(a, b) {
    return a.length === b.length && a.every(function (value, index) {
      return value === b[index];
    });
  }

  function isTextTarget(target) {
    return !!target && target.nodeType === 1 && (
      target.isContentEditable ||
      /^(INPUT|TEXTAREA|SELECT)$/.test(String(target.tagName).toUpperCase())
    );
  }

  // 「保存して…／捨てて…／続ける」の3択。actions.save は保存できたとき true を返す関数、actions.discard は捨てる関数。
  // 選択画面の Esc は「続ける」。'saved'・'discarded'・'stay' を返す
  function askLeave(labels, actions) {
    injectStyle();
    const text = labels || {};

    return new Promise(function (resolve) {
      const dialog = make('dialog', null, 'ol-ask');
      dialog.appendChild(make('h2', '保存していないものがあります'));
      const choices = make('div', null, 'ol-choices');
      const saveChoice = make('button', text.save || '保存して閉じる', 'ol-primary');
      const discardChoice = make('button', text.discard || '捨てて閉じる');
      const stayChoice = make('button', text.stay || '続ける');
      saveChoice.type = discardChoice.type = stayChoice.type = 'button';
      let answer = 'stay';

      saveChoice.addEventListener('click', async function () {
        saveChoice.disabled = true;
        answer = (await actions.save()) ? 'saved' : 'stay';
        dialog.close();
      });

      discardChoice.addEventListener('click', function () {
        actions.discard();
        answer = 'discarded';
        dialog.close();
      });

      stayChoice.addEventListener('click', function () {
        dialog.close();
      });

      dialog.addEventListener('close', function () {
        dialog.remove();
        resolve(answer);
      });

      choices.append(saveChoice, discardChoice, stayChoice);
      dialog.appendChild(choices);
      document.body.appendChild(dialog);
      dialog.showModal();
      stayChoice.focus();
    });
  }

  function create(options) {
    injectStyle();

    let items = [];                 // 保存済みの並び [{id, group, time, ...}]
    let draft = null;               // 下書きの ID の並び（変更がなければ null）
    let selectedId = '';
    let busy = false;
    let dragging = null;
    let pendingItems = null;

    const list = make('ol', null, 'ol-list');
    const actions = make('div', null, 'ol-actions');
    const saveButton = make('button', '保存', 'ol-save');
    const discardButton = make('button', '変更を戻す');
    const live = make('div', null, 'ol-live');
    live.setAttribute('aria-live', 'polite');
    saveButton.type = 'button';
    discardButton.type = 'button';
    actions.append(saveButton, discardButton);
    const root = make('div', null, 'ol-root');
    root.append(list, actions, live);

    function baseIds() {
      return items.map(function (item) {
        return item.id;
      });
    }

    function currentIds() {
      return draft || baseIds();
    }

    function itemOf(id) {
      return items.find(function (item) {
        return item.id === id;
      });
    }

    function canEdit() {
      return !busy && (!options.canEdit || options.canEdit());
    }

    function isDirty() {
      return !!draft;
    }

    function setDraft(ids) {
      draft = same(ids, baseIds()) ? null : ids;
    }

    function render() {
      const ids = currentIds();
      const editable = canEdit();
      list.replaceChildren();

      if (!ids.length) {
        list.appendChild(make('li', options.empty || 'なし', 'ol-empty'));
      }

      ids.forEach(function (id, index) {
        const item = itemOf(id);

        if (!item) {
          return;
        }

        const row = make(
          'li',
          null,
          'ol-row' + (id === selectedId ? ' is-selected' : '') + (item.locked ? ' is-locked' : '')
        );

        row.dataset.id = id;
        row.dataset.group = item.group || '';

        const grip = make('button', '≡', 'ol-grip');
        grip.type = 'button';
        grip.setAttribute('aria-label', '並びを動かす');
        grip.disabled = !editable || !!item.fixed;
        grip.addEventListener('pointerdown', function (event) {
          startDrag(event, row, id);
        });

        const body = make('div', null, 'ol-body');
        body.appendChild(options.renderRow(item, { index: index, rank: index + 1 }));

        const move = make('div', null, 'ol-move');
        const up = make('button', '上へ');
        const down = make('button', '下へ');
        up.type = 'button';
        down.type = 'button';
        up.disabled = !editable || !!item.fixed || neighbor(ids, index, -1) < 0;
        down.disabled = !editable || !!item.fixed || neighbor(ids, index, 1) < 0;
        up.addEventListener('click', function () {
          moveBy(id, -1);
        });
        down.addEventListener('click', function () {
          moveBy(id, 1);
        });
        move.append(up, down);

        row.append(grip, make('span', String(index + 1), 'ol-no'), body);

        if (item.time) {
          row.appendChild(make('span', item.time, 'ol-time'));
        }

        row.appendChild(move);

        row.addEventListener('click', function (event) {
          if (!event.target.closest('button, a, input, textarea, select')) {
            selectedId = id;
            applySelection();
          }
        });

        list.appendChild(row);
      });

      saveButton.disabled = !isDirty() || !canEdit();
      discardButton.disabled = !isDirty() || busy;
    }

    // 同じ group の隣の位置（なければ -1）
    function neighbor(ids, index, step) {
      const group = (itemOf(ids[index]) || {}).group || '';

      for (let at = index + step; at >= 0 && at < ids.length; at += step) {
        const other = itemOf(ids[at]) || {};

        if (!other.fixed && (other.group || '') === group) {
          return at;
        }
      }

      return -1;
    }

    function applySelection() {
      Array.from(list.children).forEach(function (row) {
        row.classList.toggle('is-selected', row.dataset.id === selectedId);
      });
    }

    function announce(text) {
      live.textContent = text;
    }

    function moveBy(id, step) {
      if (!canEdit()) {
        return false;
      }

      const ids = currentIds().slice();
      const from = ids.indexOf(id);
      const to = from < 0 ? -1 : neighbor(ids, from, step);

      if (to < 0) {
        return false;
      }

      const swap = ids[to];
      ids[to] = ids[from];
      ids[from] = swap;
      selectedId = id;
      setDraft(ids);
      render();
      announce((ids.indexOf(id) + 1) + '番目へ動かしました');

      const row = Array.from(list.children).find(function (node) {
        return node.dataset.id === id;
      });

      if (row) {
        row.scrollIntoView({ block: 'nearest' });
      }

      return true;
    }

    function select(step) {
      const ids = currentIds();

      if (!ids.length) {
        return false;
      }

      const at = ids.indexOf(selectedId);
      const next = at < 0
        ? (step > 0 ? 0 : ids.length - 1)
        : Math.max(0, Math.min(ids.length - 1, at + step));

      selectedId = ids[next];
      applySelection();

      const row = Array.from(list.children).find(function (node) {
        return node.dataset.id === selectedId;
      });

      if (row) {
        row.scrollIntoView({ block: 'nearest' });
      }

      return true;
    }

    /* ---------- ドラッグ ---------- */

    function startDrag(event, row, id) {
      if (!canEdit() || (event.pointerType === 'mouse' && event.button !== 0)) {
        return;
      }

      event.preventDefault();
      const grip = event.currentTarget;

      try {
        grip.setPointerCapture(event.pointerId);
      } catch (error) {
        // 取れない環境でも、ドラッグは続ける
      }

      dragging = {
        id: id,
        row: row,
        before: currentIds().slice(),
        group: row.dataset.group,
        pointerId: event.pointerId
      };

      selectedId = id;
      row.classList.add('is-dragging');
      grip.addEventListener('pointermove', onMove);
      grip.addEventListener('pointerup', onUp);
      grip.addEventListener('pointercancel', onCancel);
    }

    function onMove(event) {
      if (!dragging || event.pointerId !== dragging.pointerId) {
        return;
      }

      const others = Array.from(list.children).filter(function (row) {
        return row !== dragging.row && row.dataset.group === dragging.group && row.dataset.id;
      });

      let before = null;

      for (let index = 0; index < others.length; index++) {
        const box = others[index].getBoundingClientRect();

        if (event.clientY < box.top + box.height / 2) {
          before = others[index];
          break;
        }
      }

      if (before) {
        if (dragging.row.nextElementSibling !== before) {
          list.insertBefore(dragging.row, before);
        }
      } else if (others.length) {
        const last = others[others.length - 1];

        if (last.nextElementSibling !== dragging.row) {
          list.insertBefore(dragging.row, last.nextElementSibling);
        }
      }
    }

    function endDrag() {
      const grip = dragging.row.querySelector('.ol-grip');

      if (grip) {
        grip.removeEventListener('pointermove', onMove);
        grip.removeEventListener('pointerup', onUp);
        grip.removeEventListener('pointercancel', onCancel);
      }

      dragging.row.classList.remove('is-dragging');
    }

    function onUp(event) {
      if (!dragging || event.pointerId !== dragging.pointerId) {
        return;
      }

      const ids = Array.from(list.children)
        .map(function (row) {
          return row.dataset.id;
        })
        .filter(Boolean);

      endDrag();
      dragging = null;
      setDraft(ids);
      flushPending();
      render();

      if (options.onDragEnd) {
        options.onDragEnd();
      }
    }

    function onCancel() {
      if (!dragging) {
        return;
      }

      endDrag();
      dragging = null;
      flushPending();
      render();

      if (options.onDragEnd) {
        options.onDragEnd();
      }
    }

    /* ---------- 保存・戻す・入れ替え ---------- */

    async function save() {
      if (!draft || !canEdit()) {
        return false;
      }

      busy = true;
      render();

      try {
        await options.onSave(draft.slice());
        draft = null;
        return true;
      } catch (error) {
        return false;
      } finally {
        busy = false;
        render();
      }
    }

    function discard() {
      draft = null;
      render();
    }

    function flushPending() {
      if (pendingItems) {
        const next = pendingItems;
        pendingItems = null;
        applyItems(next);
      }
    }

    function applyItems(next) {
      items = next;

      if (draft) {
        const known = new Set(baseIds());
        const kept = draft.filter(function (id) {
          return known.has(id);
        });

        baseIds().forEach(function (id) {
          if (kept.indexOf(id) < 0) {
            kept.push(id);
          }
        });

        setDraft(kept);
      }

      if (selectedId && !itemOf(selectedId)) {
        selectedId = '';
      }

      render();
    }

    // 保存済みの並びを受け取る。ドラッグ中は終わってから反映する
    function setItems(next) {
      if (dragging) {
        pendingItems = next;
        return;
      }

      applyItems(next);
    }

    // 下書きがあるとき「保存して…／捨てて…／続ける」を聞く。'saved'・'discarded'・'stay' を返す
    function confirmLeave(labels) {
      if (!isDirty()) {
        return Promise.resolve('discarded');
      }

      return askLeave(labels, {
        save: save,
        discard: discard
      });
    }

    // キー操作。使ったら true（preventDefault 済み）。入力欄・日本語変換中・Ctrl/Meta 付きでは使わない
    function handleKey(event) {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229 ||
        event.ctrlKey ||
        event.metaKey ||
        isTextTarget(event.target) ||
        document.querySelector('dialog[open]')
      ) {
        return false;
      }

      const key = String(event.key || '').normalize('NFKC').toLowerCase();

      if (event.altKey && (key === 'arrowup' || key === 'arrowdown')) {
        if (selectedId) {
          event.preventDefault();
          moveBy(selectedId, key === 'arrowup' ? -1 : 1);
          return true;
        }

        return false;
      }

      if (event.altKey || event.shiftKey) {
        return false;
      }

      const onControl = !!event.target && event.target.nodeType === 1 &&
        /^(BUTTON|A)$/.test(String(event.target.tagName).toUpperCase());

      if (onControl) {
        return false;
      }

      if (key === 'arrowdown' || key === 'j') {
        event.preventDefault();
        return select(1);
      }

      if (key === 'arrowup' || key === 'k') {
        event.preventDefault();
        return select(-1);
      }

      if (key === 'enter' && isDirty()) {
        event.preventDefault();
        save();
        return true;
      }

      return false;
    }

    function mount(host) {
      host.replaceChildren(root);
    }

    saveButton.addEventListener('click', save);
    discardButton.addEventListener('click', discard);

    return {
      setItems: setItems,
      isDirty: isDirty,
      save: save,
      discard: discard,
      confirmLeave: confirmLeave,
      handleKey: handleKey,
      moveBy: moveBy,
      select: select,
      currentIds: currentIds,
      selectedId: function () {
        return selectedId;
      },
      refresh: render,
      mount: mount,
      isDragging: function () {
        return !!dragging;
      }
    };
  }

  window.OrderList = {
    create: create,
    askLeave: askLeave
  };
})();
