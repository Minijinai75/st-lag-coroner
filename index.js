/**
 * 卡頓驗屍官 (st-lag-coroner) — 雲端酒館卡頓的「量測 + 誠實診斷」前端擴充
 * ============================================================================
 * 由「五位專家研究 → 矛盾地圖 → 整合簡報 → 同儕審查」流程淬鍊出的 V1 範圍。
 *
 * 核心洞見（A/B 分帳）：「卡頓」其實是兩個物理上不重疊的變數——
 *   (A) 伺服器進程 RSS：跨使用者共享、瀏覽器沙箱物理碰不到、要 Node/fs/proc 權限。
 *   (B) 手機主執行緒每幀渲染預算：每台瀏覽器各自獨立、純前端可解。
 * 純前端擴充只碰得到 B，碰不到 A。所以本擴充【誠實劃界】：
 *
 *   做：量測手機端流暢度(B)、環境健檢、長聊天勸導、把 A 的問題指回伺服器。
 *   不做：修 Node 記憶體洩漏、讀 /proc、清磁碟、重啟服務、攔 fetch、碰 #chat 渲染。
 *         （串流節流要 monkey-patch StreamingProcessor、真 DOM 虛擬化會與柏宝箱搶
 *           #chat .mes——同儕審查判定兩者違反「不碰核心/不搶 DOM」鐵律，排除出 V1。）
 *
 * 鐵律（同儕審查 recommendedScopeForV1）：
 *   - 所有事件監聽器用「具名函式參考」註冊，onDisable 時 removeListener
 *     （eventSource 沒有 off()，只有 removeListener 且要同一參考，03-events 陷阱 §1）；
 *     否則本擴充自己會變成 detached DOM 洩漏源。
 *   - 不掛高頻事件（不碰 STREAM_TOKEN_RECEIVED）。量測類只在使用者主動觸發的
 *     10 秒時窗內取樣（避免觀察者效應自製卡頓）。
 *   - 所有 API 走 globalThis.SillyTavern.getContext()（02-getcontext-api）。
 *   - 設定存 extension_settings + saveSettingsDebounced（04-settings-persistence）。
 *   - 手機 UI 一律走 ST Popup API（top layer 不受 html transform / z-index 影響，
 *     10-css-theming-mobile 陷阱 1/7）。
 *
 * 證據路徑相對於 _st_source/。對照 ST 1.18.0。
 */

'use strict';

/** 模組識別字（資料夾名／console 標記／第三方擴充 i18n 與模板路徑都從它派生） */
const MODULE_NAME = 'st-lag-coroner';
/** extension_settings 下的命名空間 key（第三方要自己建，04 陷阱 §2） */
const SETTINGS_KEY = 'stLagCoroner';
const LOG = '[卡頓驗屍官]';

/** 預設設定（逐 key 補洞用；shallow Object.assign 不會自動補新欄位，04 陷阱 §1） */
const DEFAULTS = {
    enabled: true,
    healthCheckOnLoad: true,
    longChatNudge: true,
    longChatThreshold: 600,
};

/** 計畫書對雲端卡頓的核心推薦擴充安裝網址 */
const COCKTAIL_PLUS_URL = 'https://github.com/Lianues/cocktail-plus';
const COCKTAIL_URL = 'https://github.com/Lianues/cocktail';
const BAIBAI_URL = 'https://github.com/baibai-git/ST-BaiBai-Tools';

/* ------------------------------------------------------------------ */
/* 模組層級狀態（具名 handler 與量測狀態，removeListener / 清理都靠它）   */
/* ------------------------------------------------------------------ */

/** 已提示過的聊天 id（每個聊天每 session 只勸導一次，避免洗版） */
const nudgedChats = new Set();

/** 事件是否已接線（防 activate hook 在同一 session 被呼叫兩次造成重複註冊） */
let listenersWired = false;

/** 被動的生成計時（只記時間戳，近乎零成本，可常駐） */
const lastGen = { startTs: 0, lastDurationMs: 0 };

/** 感知延遲量測狀態（只在使用者按下後的 10 秒時窗內運作） */
const gauge = {
    sampling: false,
    frames: [],
    longtasks: [],
    longtaskSupported: false,
    observer: null,
    rafId: 0,
    timer: 0,
    start: 0,
    lastFrame: 0,
};

/**
 * 每次使用都重新取 context，不長期快取（chat_metadata 等是 let、會被整顆換掉，
 * 04 陷阱 §6）。
 * @returns {object|null}
 */
function getCtx() {
    try {
        return globalThis.SillyTavern?.getContext?.() ?? null;
    } catch {
        return null;
    }
}

/**
 * 取得（並確保存在＋補齊預設值的）本擴充設定。
 * @returns {object}
 */
function getSettings() {
    const root = getCtx()?.extensionSettings;
    if (!root) {
        return { ...DEFAULTS };
    }
    root[SETTINGS_KEY] = root[SETTINGS_KEY] || {};
    const s = root[SETTINGS_KEY];
    for (const k in DEFAULTS) {
        if (s[k] === undefined) {
            s[k] = DEFAULTS[k];
        }
    }
    return s;
}

/** 排程儲存設定（1 秒防抖，不需 await，04 §saveSettingsDebounced） */
function save() {
    getCtx()?.saveSettingsDebounced?.();
}

/* ------------------------------------------------------------------ */
/* 環境健檢（純讀取，只「說」哪裡有問題、不改任何東西）                  */
/* ------------------------------------------------------------------ */

/**
 * 列出目前【已載入】的第三方擴充資料夾名。
 * 依據：addExtensionScript 對第三方擴充建立 <script src="/scripts/extensions/
 * third-party/<folder>/<js>">（extensions.js:813-819；name 帶 third-party/ 前綴，
 * 01-lifecycle）。掃 script src 比猜 globalThis 標記可靠，且只會掃到「啟用中」的
 * （停用的擴充 JS 不會被注入，activate 階段被擋，extensions.js:626-628）。
 * @returns {string[]}
 */
function listThirdPartyExtensions() {
    const set = new Set();
    document.querySelectorAll('script[src*="/scripts/extensions/third-party/"]').forEach((s) => {
        const m = /\/scripts\/extensions\/third-party\/([^/]+)\//.exec(s.getAttribute('src') || '');
        if (m) {
            set.add(decodeURIComponent(m[1]));
        }
    });
    return [...set];
}

/**
 * 跑一次環境健檢（async：要探測 cocktail-plus 後端）。把發現渲染進面板。
 * 部分發現帶「一鍵動作」按鈕（關閉 auto_load_chat、複製安裝網址…），
 * 讓它不只「說問題」、而是能直接幫上忙。
 */
async function runHealthCheck() {
    const ctx = getCtx();
    if (!ctx) {
        return;
    }
    const s = getSettings();
    const findings = [];

    // 1. cocktail / cocktail-plus —— 計畫書對雲端卡頓的【核心推薦】，含「半套安裝」偵測
    await checkCocktail(findings);

    // 2. 柏宝箱在場：本擴充刻意與它零重疊（不攔 fetch、不碰 #chat），只是告知共存
    //    （globalThis.__baiBaiToolkitExtensionInstalled 為柏宝箱寫入，baibai §3.7）
    if (globalThis.__baiBaiToolkitExtensionInstalled) {
        findings.push({
            level: 'info',
            text: '偵測到柏宝箱（BaiBai-Tools）在場：手機端 fetch/DOM 優化交給它。本擴充與它零重疊。',
        });
    } else {
        findings.push({
            level: 'info',
            text: '沒偵測到柏宝箱（BaiBai-Tools）。它做手機端 fetch 攔截優化、長聊天虛擬化、存檔去重，雲端手機族有感，可搭配 cocktail-plus 一起裝。',
            action: { label: '複製柏宝箱安裝網址', fn: () => copyUrl(BAIBAI_URL) },
        });
    }

    // 3. 雲端用不到的桌面包裝器（TauriTavern 類）：純佔空間
    const tp = listThirdPartyExtensions();
    const tauri = tp.filter((n) => /tauri/i.test(n));
    if (tauri.length) {
        findings.push({
            level: 'warn',
            text: `偵測到 ${tauri.join('、')}（TauriTavern 類桌面包裝器），雲端用不到、純佔磁碟空間，建議移除。`,
        });
    }

    // 4. 擴充數量過多（計畫書 §1.3 列為卡頓三大成因之一）
    if (tp.length >= 15) {
        findings.push({
            level: 'info',
            text: `目前載入 ${tp.length} 個第三方擴充。擴充數量過多是雲端卡頓三大成因之一，建議定期移除用不到的。`,
        });
    }

    // 5. 長聊天 + 自動載入上次聊天（附一鍵關閉，走 ST 官方 checkbox handler）
    //    （powerUserSettings.auto_load_chat：st-context.js:228；power-user.js:335 預設 false）
    const chatLen = Array.isArray(ctx.chat) ? ctx.chat.length : 0;
    const autoLoad = !!ctx.powerUserSettings?.auto_load_chat;
    const fixAuto = { label: '幫我關掉自動載入', fn: disableAutoLoadChat };
    if (autoLoad && chatLen >= s.longChatThreshold) {
        findings.push({
            level: 'warn',
            text: `「自動載入上次聊天」開著，且目前聊天 ${chatLen} 樓。每次開酒館都要載入這條長聊天，拖慢啟動又加重手機 DOM。`,
            action: fixAuto,
        });
    } else if (chatLen >= s.longChatThreshold) {
        findings.push({
            level: 'info',
            text: `目前聊天 ${chatLen} 樓（已超過門檻 ${s.longChatThreshold}）。長聊天讓手機畫面變重，可考慮開新檔或重新整理分頁。`,
        });
    } else if (autoLoad) {
        findings.push({
            level: 'info',
            text: '「自動載入上次聊天」開著。若上次聊天很長，啟動會比較慢。',
            action: fixAuto,
        });
    }

    // 6. 載入訊息數（chat_truncation）== 0 → 渲染整段歷史，是手機越用越卡最直接的原因。
    //    script.js:1434/1477：0 會 fallback 成 MAX_SAFE_INTEGER（全載入）；預設 100（power-user.js:133）。
    //    這是 cocktail-plus 結構上碰不到的純客戶端槓桿（它是啟動/傳輸層，不管渲染幾樓）。
    const trunc = Number(ctx.powerUserSettings?.chat_truncation);
    if (ctx.powerUserSettings && trunc === 0) {
        findings.push({
            level: 'warn',
            text: '「載入訊息數」設成 0（不限制）：長聊天會把整段歷史都渲染成 DOM，是手機越用越卡最直接的原因。建議設成 100（ST 預設）。只影響渲染/載入的樓層數，不影響 AI 實際讀到的 context。',
            action: { label: '幫我設成 100', fn: () => setChatTruncation(100) },
        });
    }

    renderFindings(findings);
}

/**
 * 偵測 cocktail / cocktail-plus 狀態，並針對「半套安裝」「未安裝」給出可行動建議。
 *
 * 後端探測走 GET /api/plugins/cocktail-plus/fast/version——這是 cocktail-plus 後端
 * plugin 的 GET 路由（11-server-plugins §完整 API 面），而 GET/HEAD/OPTIONS 是
 * csrf-sync 預設豁免的方法（同篇 §CSRF 豁免），所以前端不必帶 X-CSRF-Token。
 *   - 200 → 後端 plugin 活著
 *   - 404 → 後端沒裝，或 config.yaml 的 enableServerPlugins 是 false（計畫書 §7.4）
 *   - 其他/網路錯 → 不確定（誠實標示，不亂下結論）
 * @param {Array} findings
 */
async function checkCocktail(findings) {
    const tp = listThirdPartyExtensions();
    const hasCP = tp.some((n) => /cocktail-?plus/i.test(n));
    const hasCocktail = tp.some((n) => /cocktail/i.test(n)) && !hasCP;

    const backend = await probeCocktailBackend();
    const installCP = { label: '複製 cocktail-plus 安裝網址', fn: () => copyUrl(COCKTAIL_PLUS_URL) };

    if (hasCP && backend === true) {
        findings.push({
            level: 'ok',
            text: 'cocktail-plus 前後端就緒：它加速啟動、省磁碟 I/O、縮小存檔。但它【不會】讓「用久了越來越卡」消失——那是伺服器記憶體(A，靠重啟/設記憶體上限) 或 手機渲染(B，靠下面的降「載入訊息數」、開新檔、重整)。',
        });
    } else if (hasCP && backend === false) {
        findings.push({
            level: 'warn',
            text: '疑似 cocktail-plus「半套安裝」：前端擴充裝了，但後端 plugin 探測不到（enableServerPlugins 沒開，或後端元件沒複製進 plugins/）。前端會一直空打不存在的端點、浪費資源（計畫書 §7.5）。請完整裝後端，或先在酒館停用前端 cocktail-plus 擴充。',
        });
    } else if (hasCP && backend === null) {
        findings.push({
            level: 'info',
            text: '裝了前端 cocktail-plus，但後端狀態探測不到（可能登入牆或網路）。確認 config.yaml 的 enableServerPlugins: true 並完成後端安裝（計畫書第 4 節）。',
        });
    } else if (backend === true) {
        findings.push({
            level: 'info',
            text: '偵測到 cocktail-plus 後端在跑，但前端擴充沒載入。到擴充管理啟用前端 cocktail-plus 才吃得到加速。',
        });
    } else if (hasCocktail) {
        findings.push({
            level: 'info',
            text: '已裝輕量版 cocktail（純前端快取）。它和 cocktail-plus 都是加速啟動/省 I/O，對「用久了越來越卡」幫不上——那要看 A/B（見下方量測與對策）。',
        });
    } else {
        findings.push({
            level: 'info',
            text: '沒裝 cocktail-plus。它能加速啟動、省磁碟 I/O、縮小存檔（對「開很慢/卡齒輪」有感），但【不是】「用久了越來越卡」的解藥——別期待裝了就不卡。要裝可一鍵複製網址。',
            action: installCP,
        });
    }
}

/**
 * 探測 cocktail-plus 後端是否在跑。
 * 同時打兩條已知的 GET 路由（CSRF 豁免）以降低誤判：sw.js、fast/version
 * （11-server-plugins §完整 API 面）。
 *   - 任一個回 200 → 後端確定活著（true）
 *   - 兩條都回 404 → 後端確定沒裝/enableServerPlugins 沒開（false）
 *   - 其他（401/403/5xx/網路錯）→ 不確定（null），不亂下「半套安裝」結論
 * @returns {Promise<boolean|null>}
 */
async function probeCocktailBackend() {
    const paths = ['/api/plugins/cocktail-plus/sw.js', '/api/plugins/cocktail-plus/fast/version'];
    let saw404 = false;
    let sawOther = false;
    for (const p of paths) {
        try {
            const r = await fetch(p, { method: 'GET', credentials: 'same-origin' });
            if (r.ok) {
                return true;
            }
            if (r.status === 404) {
                saw404 = true;
            } else {
                sawOther = true;
            }
        } catch {
            sawOther = true;
        }
    }
    if (saw404 && !sawOther) {
        return false;
    }
    return null;
}

/** 一鍵關閉「自動載入上次聊天」——觸發 ST 官方 checkbox handler（power-user.js:4031-4034）。 */
function disableAutoLoadChat() {
    const ctx = getCtx();
    const cb = document.getElementById('auto-load-chat-checkbox');
    if (cb) {
        // 走官方 input handler：它自己設 power_user.auto_load_chat 並 saveSettingsDebounced
        $('#auto-load-chat-checkbox').prop('checked', false).trigger('input');
    } else if (ctx?.powerUserSettings) {
        // 設定面板還沒展開時的後備：直接設值＋存檔
        ctx.powerUserSettings.auto_load_chat = false;
        ctx.saveSettingsDebounced?.();
    }
    try {
        toastr.success('已關閉「自動載入上次聊天」。下次開酒館不會再自動載入長聊天。', '卡頓驗屍官');
    } catch { /* noop */ }
    runHealthCheck();
}

/** 一鍵把「載入訊息數」設成 n——觸發 ST 官方 #chat_truncation handler（power-user.js:3394-3398）。 */
function setChatTruncation(n) {
    const ctx = getCtx();
    const el = document.getElementById('chat_truncation');
    if (el) {
        // 官方 input handler 自己設 power_user.chat_truncation、更新 counter、saveSettingsDebounced
        $('#chat_truncation').val(n).trigger('input');
    } else if (ctx?.powerUserSettings) {
        ctx.powerUserSettings.chat_truncation = n;
        ctx.saveSettingsDebounced?.();
    }
    try {
        toastr.success(`已把「載入訊息數」設成 ${n}。重新整理分頁或切換聊天後，只渲染最近 ${n} 樓，手機會明顯變輕。`, '卡頓驗屍官');
    } catch { /* noop */ }
    runHealthCheck();
}

/** 複製安裝網址到剪貼簿（不安全情境/不支援時，退回顯示網址讓使用者長按複製）。 */
function copyUrl(url) {
    const fallback = () => {
        try {
            toastr.info(url, '安裝網址（請長按複製）', { timeOut: 0, extendedTimeOut: 0, closeButton: true, escapeHtml: true });
        } catch { /* noop */ }
    };
    if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(url).then(
            () => {
                try {
                    toastr.success('已複製安裝網址。到 Extensions → Install extension 貼上即可。', '卡頓驗屍官');
                } catch { /* noop */ }
            },
            fallback,
        );
    } else {
        fallback();
    }
}

/**
 * 把健檢發現渲染進結果區（純 textContent，符合 05「純文字一律 textContent」）。
 * @param {{level:string,text:string}[]} findings
 */
function renderFindings(findings) {
    const box = document.getElementById('slc-health-results');
    if (!box) {
        return;
    }
    box.textContent = '';
    if (!findings.length) {
        const ok = document.createElement('div');
        ok.className = 'slc-finding slc-ok';
        ok.textContent = '✅ 沒有發現明顯問題。';
        box.appendChild(ok);
        return;
    }
    for (const f of findings) {
        const row = document.createElement('div');
        row.className = 'slc-finding slc-' + f.level;
        const icon = f.level === 'warn' ? '⚠️ ' : f.level === 'ok' ? '✅ ' : 'ℹ️ ';
        const txt = document.createElement('span');
        txt.textContent = icon + f.text; // 純 textContent，零 XSS
        row.appendChild(txt);
        if (f.action && typeof f.action.fn === 'function') {
            const btn = document.createElement('div');
            btn.className = 'menu_button slc-fix-btn';
            btn.textContent = f.action.label;
            btn.addEventListener('click', f.action.fn);
            row.appendChild(btn);
        }
        box.appendChild(row);
    }
}

/* ------------------------------------------------------------------ */
/* 感知延遲量測（只量客戶端 B；預設關、限時 10 秒、避免觀察者效應）       */
/* ------------------------------------------------------------------ */

function startGauge() {
    if (gauge.sampling) {
        return;
    }
    gauge.sampling = true;
    gauge.frames = [];
    gauge.longtasks = [];
    gauge.start = performance.now();
    gauge.lastFrame = 0;
    gauge.longtaskSupported = false;

    // longtask 觀測器（Chrome/Edge 支援；Safari/Firefox 多半沒有 → 特性檢測後降級）
    try {
        const PO = globalThis.PerformanceObserver;
        if (PO && Array.isArray(PO.supportedEntryTypes) && PO.supportedEntryTypes.includes('longtask')) {
            gauge.observer = new PO((list) => {
                for (const e of list.getEntries()) {
                    gauge.longtasks.push(e.duration);
                }
            });
            gauge.observer.observe({ entryTypes: ['longtask'] });
            gauge.longtaskSupported = true;
        }
    } catch {
        gauge.longtaskSupported = false;
    }

    gauge.rafId = requestAnimationFrame(onFrame);
    gauge.timer = setTimeout(stopGauge, 10000);

    const btn = document.getElementById('slc-run-gauge');
    if (btn) {
        btn.classList.add('slc-busy');
    }
    const box = document.getElementById('slc-gauge-results');
    if (box) {
        box.textContent = '';
        const p = document.createElement('div');
        p.className = 'slc-note';
        p.textContent = '量測中… 請正常滑動聊天 10 秒。';
        box.appendChild(p);
    }
}

/** rAF 迴圈：記錄每幀間隔（跳過第一幀，首幀間隔不可靠） */
function onFrame(now) {
    if (!gauge.sampling) {
        return;
    }
    if (gauge.lastFrame) {
        gauge.frames.push(now - gauge.lastFrame);
    }
    gauge.lastFrame = now;
    gauge.rafId = requestAnimationFrame(onFrame);
}

/** 停止量測並清理所有資源（onDisable 也呼叫它，確保不殘留常駐取樣） */
function stopGauge() {
    gauge.sampling = false;
    if (gauge.timer) {
        clearTimeout(gauge.timer);
        gauge.timer = 0;
    }
    if (gauge.rafId) {
        cancelAnimationFrame(gauge.rafId);
        gauge.rafId = 0;
    }
    if (gauge.observer) {
        try {
            gauge.observer.disconnect();
        } catch { /* noop */ }
        gauge.observer = null;
    }
    const btn = document.getElementById('slc-run-gauge');
    if (btn) {
        btn.classList.remove('slc-busy');
    }
    renderGauge();
}

/** 渲染量測結果——只報純客戶端(B)事實，不對伺服器(A)做任何歸因暗示。 */
function renderGauge() {
    const box = document.getElementById('slc-gauge-results');
    if (!box) {
        return;
    }
    box.textContent = '';
    const add = (txt, cls) => {
        const d = document.createElement('div');
        d.className = 'slc-gauge-line' + (cls ? ' ' + cls : '');
        d.textContent = txt;
        box.appendChild(d);
    };

    const frames = gauge.frames.slice();
    if (!frames.length) {
        add('沒有量到資料（量測太短，或分頁切到背景被瀏覽器凍結了）。', '');
        return;
    }
    frames.sort((a, b) => a - b);
    const p95 = frames[Math.min(frames.length - 1, Math.floor(frames.length * 0.95))];
    const elapsedSec = Math.max(0.001, (performance.now() - gauge.start) / 1000);
    const fps = frames.length / elapsedSec;
    const jankFrames = frames.filter((d) => d > 33).length; // >33ms ≈ 掉到 30fps 以下

    add(`平均 ${fps.toFixed(0)} FPS（越接近 60 越順）`, fps >= 50 ? 'slc-ok' : fps >= 30 ? 'slc-info' : 'slc-warn');
    add(`p95 幀時間 ${p95.toFixed(0)} ms（越小越好，16ms ≈ 60fps）`, p95 <= 20 ? 'slc-ok' : p95 <= 40 ? 'slc-info' : 'slc-warn');
    add(`卡頓幀（>33ms）：${jankFrames} 幀`, jankFrames === 0 ? 'slc-ok' : jankFrames < 10 ? 'slc-info' : 'slc-warn');

    if (gauge.longtaskSupported) {
        const lt = gauge.longtasks;
        const maxLt = lt.length ? lt.reduce((a, b) => Math.max(a, b), 0) : 0;
        const totalLt = lt.reduce((a, b) => a + b, 0);
        add(
            `主執行緒長任務：${lt.length} 次，最長 ${maxLt.toFixed(0)} ms，總計 ${totalLt.toFixed(0)} ms`,
            lt.length === 0 ? 'slc-ok' : maxLt < 100 ? 'slc-info' : 'slc-warn',
        );
    } else {
        add('此瀏覽器不支援 longtask 量測，只顯示幀時間。', 'slc-note');
    }
    add('— 這只量你這台手機的畫面流暢度（B），量不到伺服器（A）。', 'slc-note');
}

/** 更新「上次生成耗時」唯讀文字——明確標註含網路與模型速度，不歸因伺服器。 */
function updateGenReadout() {
    const el = document.getElementById('slc-gen-readout');
    if (!el) {
        return;
    }
    el.textContent = lastGen.lastDurationMs
        ? `上次生成耗時：${(lastGen.lastDurationMs / 1000).toFixed(1)} 秒（含網路與模型速度，前端無法判斷是不是伺服器問題）`
        : '上次生成耗時：尚無資料（送一則訊息後顯示）。';
}

/* ------------------------------------------------------------------ */
/* 長聊天勸導（走 ST 官方新聊天流程，不自己重寫渲染生命週期）            */
/* ------------------------------------------------------------------ */

/**
 * 建立勸導彈窗內容（純 textContent，零 XSS）。
 * 誠實措辭：明說它只降客戶端 DOM(B)、不降 prompt 體積(A)——prompt 由 context
 * 上限決定不由樓層決定（同儕審查 feasibilityRedFlag 修正）；並列出「重新整理分頁」
 * 這個零擴充的 B 解法（同儕審查 missingAngles 補上）。
 * @param {number} chatLen
 * @returns {HTMLElement}
 */
function buildNudgeContent(chatLen) {
    const wrap = document.createElement('div');
    wrap.className = 'slc-nudge';
    const lines = [
        `這個聊天已經 ${chatLen} 樓。`,
        '長聊天會讓你的手機畫面變重（大量訊息節點要重繪），這是「客戶端卡頓（B）」。',
        '它不會增加送給 AI 的 prompt 長度——prompt 由你的 context 上限決定，不是樓層數。所以開新檔是為了手機順，不是為了省 token。',
        '最省事的兩個做法：開一個新聊天檔（舊的會保留在歷史裡），或直接重新整理分頁（清掉畫面累積、聊天內容不變）。',
    ];
    for (const t of lines) {
        const p = document.createElement('p');
        p.textContent = t;
        wrap.appendChild(p);
    }
    return wrap;
}

/**
 * 彈出勸導視窗（ST Popup API，top layer，手機安全）。
 */
async function showNudgePopup(chatLen) {
    const ctx = getCtx();
    if (!ctx) {
        return;
    }
    const ARCHIVE = 101;
    const RELOAD = 102;
    let result;
    try {
        result = await ctx.callGenericPopup(buildNudgeContent(chatLen), ctx.POPUP_TYPE.TEXT, '', {
            okButton: '知道了',
            allowVerticalScrolling: true,
            customButtons: [
                { text: '🆕 開新聊天檔', result: ARCHIVE },
                { text: '🔄 重新整理分頁', result: RELOAD },
            ],
        });
    } catch (e) {
        console.error(LOG, e);
        return;
    }
    if (result === ARCHIVE) {
        // 走 ST 官方流程：等同使用者點選單裡的「Start new chat」，ST 會自帶確認彈窗
        // 並呼叫 doNewChat（script.js:11551-11561、10558）。我們不重寫新聊天邏輯。
        $('#option_start_new_chat').trigger('click');
    } else if (result === RELOAD) {
        location.reload();
    }
}

/**
 * 判斷是否該勸導；每聊天每 session 只一次。
 */
function maybeNudge() {
    const s = getSettings();
    if (!s.enabled || !s.longChatNudge) {
        return;
    }
    const ctx = getCtx();
    if (!ctx) {
        return;
    }
    const chatId = ctx.getCurrentChatId?.();
    if (!chatId) {
        return; // 沒有開聊天（如歡迎頁）
    }
    const chatLen = Array.isArray(ctx.chat) ? ctx.chat.length : 0;
    if (chatLen < s.longChatThreshold || nudgedChats.has(chatId)) {
        return;
    }
    nudgedChats.add(chatId);
    try {
        // toastr 預設 escapeHtml:true（script.js:359），chatLen 是數字、安全
        toastr.info(
            `這個聊天已經 ${chatLen} 樓，長聊天會讓手機畫面變重。點這裡看怎麼處理。`,
            '卡頓驗屍官',
            { timeOut: 12000, extendedTimeOut: 5000, onclick: () => showNudgePopup(chatLen) },
        );
    } catch (e) {
        console.error(LOG, e);
    }
}

/* ------------------------------------------------------------------ */
/* 事件 handlers（全部具名、模組層級——removeListener 要同一參考）       */
/* ------------------------------------------------------------------ */

/** CHAT_CHANGED（'chat_id_changed'，events.js:19）：切聊天後檢查是否該勸導。 */
function onChatChanged() {
    maybeNudge();
}

/** GENERATION_STARTED（events.js:23）：記下生成開始時間（被動、零成本）。 */
function onGenStart() {
    lastGen.startTs = performance.now();
}

/** GENERATION_ENDED / STOPPED（events.js:24-25）：算出耗時、更新唯讀文字、順手勸導。 */
function onGenEnd() {
    if (lastGen.startTs) {
        lastGen.lastDurationMs = Math.round(performance.now() - lastGen.startTs);
        lastGen.startTs = 0;
        updateGenReadout();
    }
    maybeNudge(); // 聊天在使用中跨過門檻時也提示（nudgedChats 去重，不會洗版）
}

/* ------------------------------------------------------------------ */
/* 設定面板（注入 #extensions_settings2，inline-drawer 慣例）            */
/* ------------------------------------------------------------------ */

async function renderPanel(ctx) {
    if (document.getElementById('slc-root')) {
        return; // 冪等
    }
    // 第三方無預留容器，慣例掛到兩欄之一（04 §7 cocktail_plus fallback）
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host) {
        console.warn(LOG, '找不到擴充設定容器');
        return;
    }
    let html;
    try {
        // 第三方模板名帶 third-party/ 前綴（extensions.js:1769-1771）
        html = await ctx.renderExtensionTemplateAsync('third-party/' + MODULE_NAME, 'settings');
    } catch (e) {
        console.error(LOG, '設定模板載入失敗', e);
    }
    if (!html) {
        return; // 模板路徑拼錯會回 undefined → 面板無聲消失（04 陷阱 §7）
    }
    host.insertAdjacentHTML('beforeend', html); // 模板已由 ST 過 DOMPurify
    bindControls();
    loadSettingsIntoUi();
}

/** 綁定面板控制項（面板不會重渲染，直接綁；onDisable 移除 DOM 即連帶清掉 handler） */
function bindControls() {
    const enabled = document.getElementById('slc-enabled');
    if (enabled) {
        enabled.addEventListener('change', (e) => {
            getSettings().enabled = !!e.target.checked;
            save();
        });
    }
    const nudge = document.getElementById('slc-nudge-enabled');
    if (nudge) {
        nudge.addEventListener('change', (e) => {
            getSettings().longChatNudge = !!e.target.checked;
            save();
        });
    }
    const threshold = document.getElementById('slc-nudge-threshold');
    if (threshold) {
        threshold.addEventListener('change', (e) => {
            const v = parseInt(e.target.value, 10);
            if (Number.isFinite(v)) {
                getSettings().longChatThreshold = Math.max(50, v);
                save();
            }
        });
    }
    document.getElementById('slc-run-health')?.addEventListener('click', runHealthCheck);
    document.getElementById('slc-run-gauge')?.addEventListener('click', startGauge);
    document.getElementById('slc-copy-cp')?.addEventListener('click', () => copyUrl(COCKTAIL_PLUS_URL));
    document.getElementById('slc-reload')?.addEventListener('click', () => location.reload());
}

/** 把存檔值灌回 UI（先 append、綁好事件後才做，04 §4 的順序） */
function loadSettingsIntoUi() {
    const s = getSettings();
    const enabled = document.getElementById('slc-enabled');
    if (enabled) {
        enabled.checked = !!s.enabled;
    }
    const nudge = document.getElementById('slc-nudge-enabled');
    if (nudge) {
        nudge.checked = !!s.longChatNudge;
    }
    const threshold = document.getElementById('slc-nudge-threshold');
    if (threshold) {
        threshold.value = String(s.longChatThreshold);
    }
}

/* ------------------------------------------------------------------ */
/* 生命週期（manifest hooks）                                           */
/* ------------------------------------------------------------------ */

/**
 * 入口：manifest.json 的 hooks.activate: "init"。
 */
export async function init() {
    const ctx = getCtx();
    if (!ctx) {
        console.error(LOG, 'SillyTavern.getContext() 不可用，放棄初始化');
        return;
    }
    getSettings(); // 確保命名空間與預設值就位

    await renderPanel(ctx);

    // 只接低頻事件，全部具名參考（onDisable 對稱 removeListener）。
    // 用旗標防 activate 在同 session 被呼叫兩次造成重複註冊。
    if (!listenersWired) {
        const { eventSource: es, eventTypes: et } = ctx;
        es.on(et.CHAT_CHANGED, onChatChanged);
        es.on(et.GENERATION_STARTED, onGenStart);
        es.on(et.GENERATION_ENDED, onGenEnd);
        es.on(et.GENERATION_STOPPED, onGenEnd);
        listenersWired = true;
    }

    if (getSettings().healthCheckOnLoad) {
        runHealthCheck();
    }
    updateGenReadout();

    console.log(LOG, '已初始化（純前端、預設讀取，不攔 fetch、不碰 #chat、不修伺服器）');
}

/**
 * 清理：manifest.json 的 hooks.disable: "onDisable"。
 * 解除所有監聽器（避免 detached DOM 洩漏）、停止量測、移除面板 DOM。
 */
export async function onDisable() {
    const ctx = getCtx();
    if (ctx) {
        const { eventSource: es, eventTypes: et } = ctx;
        es.removeListener(et.CHAT_CHANGED, onChatChanged);
        es.removeListener(et.GENERATION_STARTED, onGenStart);
        es.removeListener(et.GENERATION_ENDED, onGenEnd);
        es.removeListener(et.GENERATION_STOPPED, onGenEnd);
    }
    listenersWired = false;
    stopGauge();
    document.getElementById('slc-root')?.remove();
    nudgedChats.clear();
}
