/* 左パネルの折りたたみ（正本は shared/side-panel.js。アプリ側の写しは編集しない） */
(function (global) {
  'use strict';

  function readStore(key, memory) {
    try {
      var v = global.localStorage.getItem(key);
      return v === null ? memory.value : v;
    } catch (e) {
      return memory.value;
    }
  }

  function writeStore(key, value, memory) {
    memory.value = value; // 保存できない環境でも、この画面を開いている間は覚えておく
    try { global.localStorage.setItem(key, value); } catch (e) { /* 保存できなくても画面は動かす */ }
  }

  function mount(opt) {
    var attr = 'data-panel-' + opt.id;
    var memory = { value: null };
    var mq = global.matchMedia('(min-width: ' + opt.minWidth + 'px)');
    var btn = global.document.createElement('button');
    btn.type = 'button';
    btn.className = 'sp-toggle sp-toggle-' + opt.mode;
    btn.setAttribute('data-sp-id', opt.id);
    opt.host.appendChild(btn);

    function collapsed() { return readStore(opt.storageKey, memory) === 'collapsed'; }

    function apply() {
      var wide = mq.matches;
      var isCollapsed = wide && collapsed();
      if (isCollapsed) opt.root.setAttribute(attr, 'collapsed');
      else opt.root.removeAttribute(attr);
      btn.hidden = !wide;
      btn.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
      btn.setAttribute('aria-label', isCollapsed ? opt.labels.open : opt.labels.close);
      btn.title = isCollapsed ? opt.labels.open : opt.labels.close;
    }

    btn.addEventListener('click', function () {
      writeStore(opt.storageKey, collapsed() ? 'open' : 'collapsed', memory);
      apply();
    });
    if (mq.addEventListener) mq.addEventListener('change', apply);
    else if (mq.addListener) mq.addListener(apply);
    apply();
    return { button: btn, refresh: apply };
  }

  global.SidePanel = { mount: mount };
})(typeof window !== 'undefined' ? window : globalThis);
