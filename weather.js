// File: weather.js

(function () {
  'use strict';

  const CACHE_KEY = 'taskWeatherForecast_v1';
  const READ_INTERVAL_MS = 5 * 60 * 1000;
  const STALE_AFTER_MS = 2 * 60 * 60 * 1000;
  const PENDING_LIMIT_MS = 10 * 60 * 1000;

  const WEATHER_CODES = {
    0: '快晴',
    1: '晴れ',
    2: '晴れ・くもり',
    3: 'くもり',
    45: '霧',
    48: '着氷性の霧',
    51: '弱い霧雨',
    53: '霧雨',
    55: '強い霧雨',
    56: '弱い凍結性の霧雨',
    57: '凍結性の霧雨',
    61: '弱い雨',
    63: '雨',
    65: '強い雨',
    66: '弱い凍結性の雨',
    67: '強い凍結性の雨',
    71: '弱い雪',
    73: '雪',
    75: '強い雪',
    77: '雪粒',
    80: '弱いにわか雨',
    81: 'にわか雨',
    82: '激しいにわか雨',
    85: '弱いにわか雪',
    86: '強いにわか雪',
    95: '雷雨',
    96: '雷雨・ひょう',
    99: '強い雷雨・ひょう'
  };

  const PERIOD_NAMES = {
    8: '朝',
    12: '昼',
    18: '夕方',
    21: '夜'
  };

  let packet = null;
  let selectedDate = '';
  let lastReadAt = 0;
  let loading = false;
  let readError = '';
  let connection = '';

  const card = document.createElement('section');
  card.className = 'task-weather';
  card.setAttribute('aria-label', '選択日の天気と気温');

  const style = document.createElement('style');

  style.textContent = `
    .task-weather {
      margin: 0 0 18px;
      padding: 14px;
      border: 1px solid #d8dfe6;
      border-radius: 10px;
      background: #f8fbff;
      overflow-wrap: anywhere;
    }

    .task-weather h3 {
      margin: 0 0 6px;
      font-size: 16px;
    }

    .task-weather p {
      margin: 6px 0;
      line-height: 1.6;
    }

    .task-weather .tw-sub {
      color: #657383;
      font-size: 12px;
    }

    .task-weather .tw-summary {
      font-size: 15px;
      font-weight: bold;
    }

    .task-weather .tw-periods {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 8px;
      margin: 12px 0;
    }

    .task-weather .tw-period {
      padding: 10px 5px;
      border: 1px solid #e1e6ee;
      border-radius: 8px;
      background: #fff;
      text-align: center;
      line-height: 1.6;
    }

    .task-weather .tw-temperature {
      font-size: 18px;
      font-weight: bold;
    }

    .task-weather .tw-warning {
      padding: 8px 10px;
      border-radius: 6px;
      color: #765200;
      background: #fff3cf;
      font-size: 12px;
      white-space: pre-wrap;
    }

    .task-weather a {
      color: #1559ad;
    }

    @media (max-width: 380px) {
      .task-weather .tw-periods {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
    }
  `;

  document.head.appendChild(style);

  /**
   * 文字列を安全に表示する要素を作る。
   */
  function element(tag, text, className) {
    const node = document.createElement(tag);

    if (text !== undefined && text !== null) {
      node.textContent = text;
    }

    if (className) {
      node.className = className;
    }

    return node;
  }

  /**
   * 天気レスポンスの基本形式を確認する。
   */
  function validPacket(value) {
    return !!value &&
      value.ok === true &&
      value.feature === 'weather-v1' &&
      (
        value.weather === null ||
        (
          value.weather &&
          typeof value.weather.fetchedAt === 'string' &&
          Array.isArray(value.weather.days)
        )
      );
  }

  /**
   * 既存アプリと同じ接続設定を読む。
   */
  function settings() {
    return {
      url: localStorage.getItem('gasUrl_v1') || '',
      token: localStorage.getItem('gasTok_v1') || ''
    };
  }

  /**
   * 接続設定の変更を識別する。値は通信先以外へ送信・保存しない。
   */
  function connectionKey(value) {
    return value.url + '\n' + value.token;
  }

  /**
   * 日本時間の今日を返す。
   */
  function today() {
    return new Date(Date.now() + 9 * 3600000)
      .toISOString()
      .slice(0, 10);
  }

  /**
   * 取得日時を日本時間で表示する。
   */
  function fetchedLabel(value) {
    const time = Date.parse(value || '');

    if (!Number.isFinite(time)) {
      return '未取得';
    }

    return new Date(time + 9 * 3600000)
      .toISOString()
      .slice(0, 16)
      .replace('T', ' ');
  }

  /**
   * 欠損値を補完せず、気温を表示する。
   */
  function temperature(value) {
    return typeof value === 'number' && Number.isFinite(value)
      ? value.toFixed(1) + '°C'
      : '—';
  }

  /**
   * WMOコードを表示名に変換する。
   */
  function weatherName(code) {
    return typeof code === 'number' && WEATHER_CODES[code]
      ? WEATHER_CODES[code]
      : '不明';
  }

  /**
   * 天気カードを描画する。タスク画面の状態は変更しない。
   */
  function draw() {
    card.replaceChildren();

    card.append(
      element('h3', '天気・気温'),
      element(
        'p',
        '石神井公園周辺 ／ ' + selectedDate + ' ／ 日本時間',
        'tw-sub'
      )
    );

    const weather = packet ? packet.weather : null;
    const day = weather
      ? weather.days.find(function (entry) {
        return entry.date === selectedDate;
      })
      : null;

    if (selectedDate < today()) {
      card.appendChild(element(
        'p',
        '予報なし。過去日の実際の天気を表示する機能ではありません。',
        'tw-sub'
      ));
    } else if (!weather) {
      card.appendChild(element(
        'p',
        loading
          ? '予報を読み込んでいます。'
          : '予報はまだ取得されていません。初期設定と更新状況を確認してください。',
        'tw-sub'
      ));
    } else if (!day) {
      card.appendChild(element(
        'p',
        '予報なし。選択日は、保存済み予報の対象期間外です。',
        'tw-sub'
      ));
    } else {
      card.appendChild(element(
        'p',
        '最高 ' + temperature(day.maxTemperature) +
          ' ／ 最低 ' + temperature(day.minTemperature),
        'tw-summary'
      ));

      card.appendChild(element(
        'p',
        '日全体：' + weatherName(day.weatherCode) +
          '（日内で最も厳しい天気の予報）',
        'tw-sub'
      ));

      const grid = element('div', null, 'tw-periods');

      (day.periods || []).forEach(function (period) {
        const cell = element('div', null, 'tw-period');

        cell.append(
          element(
            'div',
            (PERIOD_NAMES[period.hour] || '') +
              ' ' + period.hour + ':00',
            'tw-sub'
          ),
          element(
            'div',
            temperature(period.temperature),
            'tw-temperature'
          ),
          element(
            'div',
            weatherName(period.weatherCode),
            'tw-sub'
          )
        );

        grid.appendChild(cell);
      });

      card.appendChild(grid);
      card.appendChild(element(
        'p',
        '各時間帯は表示時刻の予報です。「—」はデータなしです。',
        'tw-sub'
      ));
    }

    const warnings = [];

    if (!navigator.onLine) {
      warnings.push(
        '通信がないため、この端末に保存した予報を表示しています。'
      );
    }

    if (readError) {
      warnings.push(readError);
    }

    if (packet && packet.error) {
      warnings.push('予報の更新失敗：' + packet.error);
    }

    if (packet && packet.pending) {
      const elapsed = Date.now() - Number(packet.lastAttemptAt || 0);

      warnings.push(
        elapsed < PENDING_LIMIT_MS
          ? 'サーバーで予報を更新中です。取得済みの予報を表示しています。'
          : '前回の予報更新が完了したことを確認できません。取得済みの予報を表示しています。'
      );
    }

    if (weather) {
      const fetchedAt = Date.parse(weather.fetchedAt);

      if (
        !Number.isFinite(fetchedAt) ||
        Date.now() - fetchedAt >= STALE_AFTER_MS
      ) {
        warnings.push(
          '予報の取得から2時間以上経過しているか、取得時刻を確認できません。最新情報ではない可能性があります。'
        );
      }

      card.appendChild(element(
        'p',
        '予報取得：' + fetchedLabel(weather.fetchedAt) +
          '（日本時間）／ 約1時間ごとに取得',
        'tw-sub'
      ));
    }

    if (warnings.length) {
      card.appendChild(element(
        'p',
        warnings.join('\n'),
        'tw-warning'
      ));
    }

    const source = element('p', null, 'tw-sub');
    const provider = element('a', 'Open-Meteo');
    provider.href = 'https://open-meteo.com/';
    provider.target = '_blank';
    provider.rel = 'noopener noreferrer';

    const license = element('a', 'CC BY 4.0');
    license.href = 'https://creativecommons.org/licenses/by/4.0/';
    license.target = '_blank';
    license.rel = 'noopener noreferrer';

    source.append(
      '予報データ：',
      provider,
      ' ／ ',
      license,
      '。地点・時間を抽出し、日本語表示用に整形しています。'
    );

    card.appendChild(source);
  }

  /**
   * 保存済み予報をGASから読む。
   * 既存アプリのAPI処理や未送信キューは使用しない。
   */
  async function refresh(force) {
    if (
      !card.isConnected ||
      document.hidden ||
      loading ||
      !navigator.onLine
    ) {
      return;
    }

    let config;

    try {
      config = settings();
    } catch (error) {
      readError = '接続設定を読み取れませんでした。';
      draw();
      return;
    }

    const requestedConnection = connectionKey(config);

    if (connection !== requestedConnection) {
      connection = requestedConnection;
      lastReadAt = 0;
    }

    if (!config.url || !config.token) {
      readError = '既存アプリの接続先と合い言葉を設定してください。';
      draw();
      return;
    }

    if (!force && Date.now() - lastReadAt < READ_INTERVAL_MS) {
      return;
    }

    lastReadAt = Date.now();
    loading = true;
    draw();

    const controller = new AbortController();

    const timer = setTimeout(function () {
      controller.abort();
    }, 60000);

    try {
      const response = await fetch(config.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain;charset=utf-8'
        },
        body: JSON.stringify({
          mode: 'weather',
          action: 'load',
          token: config.token
        }),
        redirect: 'follow',
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(
          '天気データを読み取れませんでした（HTTP ' +
            response.status + '）。'
        );
      }

      const result = await response.json();

      if (!result || result.ok !== true) {
        throw new Error(
          result && result.message
            ? result.message
            : '天気データを読み取れませんでした。'
        );
      }

      if (!validPacket(result)) {
        throw new Error(
          '天気に対応した返答ではありません。GASのデプロイ更新を確認してください。'
        );
      }

      if (requestedConnection !== connectionKey(settings())) {
        lastReadAt = 0;
        return;
      }

      packet = result;
      readError = '';

      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(result));
      } catch (error) {
        readError =
          '予報は取得しましたが、オフライン表示用に端末へ保存できませんでした。';
      }
    } catch (error) {
      readError = error && error.name === 'AbortError'
        ? '天気データの読み取りが時間切れになりました。保存済み予報があれば表示しています。'
        : '天気データの読み取り失敗：' +
          String(error.message || error);
    } finally {
      clearTimeout(timer);
      loading = false;
      draw();
    }
  }

  /**
   * 選択日の天気カードを、1日の計画に配置する。
   */
  function mount(container, date) {
    selectedDate = date;
    container.appendChild(card);

    try {
      draw();
      refresh(false);
    } catch (error) {
      card.replaceChildren(element(
        'p',
        '天気表示を準備できませんでした。タスク操作はそのまま利用できます。',
        'tw-warning'
      ));
    }
  }

  try {
    const saved = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');

    if (validPacket(saved)) {
      packet = saved;
    }
  } catch (error) {
    // 天気キャッシュだけを無視し、既存の端末データは変更しない。
  }

  window.TaskWeather = Object.freeze({
    mount: mount
  });

  setInterval(function () {
    refresh(false);
  }, 60000);

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) {
      refresh(true);
    }
  });

  window.addEventListener('online', function () {
    refresh(true);
  });

  window.addEventListener('offline', function () {
    if (card.isConnected) {
      draw();
    }
  });

  window.addEventListener('storage', function (event) {
    if (
      event.key === 'gasUrl_v1' ||
      event.key === 'gasTok_v1' ||
      event.key === null
    ) {
      lastReadAt = 0;
      refresh(true);
    }
  });

  const reload = document.getElementById('reload');

  if (reload) {
    reload.addEventListener('click', function () {
      refresh(true);
    });
  }
}());
