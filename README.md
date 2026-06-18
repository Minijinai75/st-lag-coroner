# 卡頓驗屍官 (st-lag-coroner)

> 雲端酒館卡頓的「**量測先行 + 誠實診斷**」前端擴充。
> 適用 SillyTavern 1.18.0（雲端 / Zeabur / 手機族）。
> 建立：26/06/18 14:42（台灣時間）

---

## 它解決什麼

雲端酒館「卡頓」這個詞，其實混了**兩個物理上不重疊的變數**：

| | A：伺服器進程 RSS | B：手機主執行緒每幀渲染預算 |
|---|---|---|
| 在哪 | Node 進程（伺服器側） | 每台瀏覽器各自獨立 |
| 誰承擔 | 所有使用者一起卡 | 只有這台手機卡 |
| 前端碰得到嗎 | **碰不到**（要 fs / process / /proc 權限） | **碰得到** |
| 怎麼治 | memory limit + OOMKill、config 調參、重啟（維運側） | 開新檔、重新整理、量測後再優化（前端側） |

計畫書把兩者壓成「卡頓疊加」一句話，並把 A 的「記憶體洩漏」列為最大元兇——但**全文沒有任何一筆把它和使用者「感覺卡」對齊的量測**。每日重啟之所以有效，有一半功勞其實是順手清掉了客戶端那棵肥大的 `.mes` DOM 樹（B），卻被記在伺服器（A）帳上。

**這個擴充就是那把缺掉的尺**：先在手機端量出你這一卡到底在 A 還是 B，再只誠實承擔前端碰得到的那半。

---

## 做什麼 / 不做什麼（誠實劃界）

✅ **做**（全部純前端、預設讀取、可關；能一鍵的就幫你按）

- **環境健檢**（含一鍵修）：
  - **cocktail / cocktail-plus**（計畫書核心推薦）：GET 探測後端 `/api/plugins/cocktail-plus/fast/version`，認出「**半套安裝**」（前端有、後端沒回應 → 空打端點浪費資源，計畫書 §7.5）；沒裝就建議安裝並附**一鍵複製安裝網址**。
  - 柏宝箱在場（自動讓位）／沒裝（附複製安裝網址）。
  - 雲端用不到的擴充（TauriTavern）、第三方擴充數量過多。
  - 「自動載入上次聊天 + 超長聊天」拖慢組合 → **一鍵幫你關掉**（走 ST 官方 checkbox handler，不猜內部）。
  - **「載入訊息數」(`chat_truncation`) 設成 0** → 長聊天渲染整段歷史 = 手機越用越卡最直接的原因 → **一鍵設成 100**。這是 cocktail-plus 結構上碰不到的純客戶端槓桿。
- **一鍵快速動作**：複製 cocktail-plus 安裝網址、重新整理分頁（清客戶端 DOM 累積）。
- **感知延遲量測**（預設關、限時 10 秒）：用 `PerformanceObserver('longtask')` + `requestAnimationFrame` 量你這台手機的 FPS、p95 幀時間、卡頓幀、主執行緒長任務。**只報客戶端(B)事實，不對伺服器(A)做任何歸因**。
- **長聊天勸導**：聊天過長時提示開新檔，一鍵走 ST 官方新聊天流程（`#option_start_new_chat`，會自帶確認），或建議重新整理分頁。
- **卡頓對策清單（誠實分類，不賣萬靈丹）**：把「用久了越來越卡」（主訴）和「卡齒輪/冷啟動」分開。前者 cocktail-plus 治不了——要量 A/B：A（伺服器記憶體）靠重啟/記憶體上限、B（手機渲染）靠降載入訊息數/開新檔/重整；cocktail-plus 與 config 調參歸在「冷啟動」那類。

❌ **不做**（前端物理上做不到，或會踩雷）

- 不修 Node.js 伺服器端記憶體洩漏（瀏覽器沙箱碰不到 Node heap）。
- 不讀 /proc、不清磁碟、不淺層化 .git、不重啟服務、不跑 cron（要 server plugin，那是 cocktail-plus 的活）。
- 不攔截 / 改寫 `fetch`、不共用 ST 的 `custom-style`、不吞 `/api/chats/save`（不製造「資料看似消失」那類隱性債、不與柏宝箱的 fetch 鏈打架）。
- 不重做柏宝箱已做完的客戶端優化（content-visibility 虛擬化、gzip 壓存檔、IME 守門…）。
- 不做需要後端的「維運遙控面板」（讀記憶體 / 清快取 / 自重啟按鈕）——列為未來 v2 方向。

### 同儕審查砍掉的兩個功能（為什麼不在 V1）

- **串流節流**：要 coalesce 串流期渲染必須 monkey-patch 核心 `StreamingProcessor` 私有實作，違反「不碰核心 patch」鐵律。先用量測證明串流 jank 是你這台手機的主瓶頸，再單獨評估。
- **真 DOM 虛擬化**：會與柏宝箱同時操作 `#chat .mes`，是結構性共存衝突而非單純 stretch 風險。

---

## 安裝

**方法 A — Install from URL（推薦）**

酒館 → Extensions → Install extension → 貼上本 repo 的 git URL → Install。

**方法 B — 手動**

把整個 `st-lag-coroner/` 資料夾放到：

```
<酒館資料目錄>/data/<使用者>/extensions/st-lag-coroner/
```

重新整理頁面。到 Extensions 設定頁就會看到「🩺 卡頓驗屍官 Lag Coroner」面板。

> 載入順序 `loading_order: 50`：刻意排在柏宝箱（-1000）與內建擴充（1–12）之後，**不與它們搶最內層 fetch 或最早 hook**。

---

## 使用

1. 打開 Extensions 設定頁的「卡頓驗屍官」面板。
2. **先看環境健檢**——它會點名最便宜的幾個改善點。
3. **感到卡時按「開始量測（10 秒）」**，正常滑動聊天。看結果：
   - 若 FPS 低、卡頓幀多、長任務多 → 卡在 **B（你手機畫面）**，開新檔 / 重新整理 / 減少擴充會有感。
   - 若畫面量起來很順，但「上次生成耗時」很長 → 多半是 **A 或網路/模型**，展開「維運提示卡」照做，裝前端擴充救不了。
4. 長聊天到門檻會自動跳一次溫和提示（每聊天每 session 一次）。

---

## 正確的落地順序（對使用者最誠實）

1. **先請維運者給 Pod 設 memory limit**（投報率輾壓任何擴充，讓 OOMKill 取代凌晨 cron）。
2. 裝**柏宝箱 + cocktail-plus**解客戶端卡與啟動加速。
3. **最後**才裝這個「量測 + 補完那半 + 健檢」的擴充。

順序反過來就是燒 token 又沒感。

---

## 共存

- **柏宝箱（BaiBai-Tools）**：零重疊。本擴充不攔 fetch、不碰 `#chat` 渲染、不共用 `custom-style`；偵測到 `__baiBaiToolkitExtensionInstalled` 會在健檢裡標明。
- 命名空間：DOM id/class 一律 `slc-` 前綴，設定存 `extension_settings.stLagCoroner`，不佔用 `globalThis`。
- 生命週期：所有事件監聽器都用具名參考註冊，停用時 `removeListener` 並移除面板 DOM、停止量測——**不讓自己變成 detached DOM 洩漏源**。

---

## 技術備忘（升級 ST 時回查）

- 事件名：`CHAT_CHANGED='chat_id_changed'`、`GENERATION_STARTED/ENDED/STOPPED`（`events.js:19,23-25`）。
- 新聊天：點 `#option_start_new_chat`（`index.html:8155`）→ ST 自帶確認 → `doNewChat`（`script.js:11551-11561,10558`）。
- 設定：`getContext().powerUserSettings.auto_load_chat`（`st-context.js:228`；`power-user.js:335`）。
- 面板：`renderExtensionTemplateAsync('third-party/st-lag-coroner','settings')` → `settings.html`。

---

## 這份東西怎麼來的

V1 範圍由「五位觀點截然不同的專家（從業者 / 懷疑論者 / 經濟學家 / 歷史學家 / 學者）→ 矛盾地圖 → 整合簡報 → 嚴格同儕審查」的研究流程淬鍊。最關鍵的結論是 **A/B 分帳**，以及同儕審查砍掉了兩個「聽起來很美但技術上違反自訂鐵律」的功能。一份沒有任何單一視角寫得出來的規格。
