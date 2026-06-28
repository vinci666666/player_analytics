# 玩家投注行為與財務曲線分析器 (Player Betting Behavior & Financial Curve Analyzer)

這是一個專業的 iGaming 數據分析工具套件，旨在對老虎機旋轉日誌進行每日分區、按時間順序進行投注編號、偵測玩家切換遊戲的行為，並繪製以印尼盾 (IDR) 為單位的每日累計利潤曲線。

## 📂 專案目錄結構

```text
player_analysis/
├── sql/
│   └── analytical_query.sql      # PostgreSQL 視窗函數分析查詢
├── python/
│   └── analyzer.py               # Pandas 分析引擎與 Plotly 圖表導出器
├── web/
│   ├── index.html                # 進階 HTML5 儀表板模板
│   ├── style.css                 # 玻璃擬態 Cyber-Dark 風格樣式表
│   └── app.js                    # Javascript 數據引擎與 Plotly.js 圖表
└── README.md                     # 本說明文件 (中文版)
```

---

## ⚡ 1. PostgreSQL 視窗函數查詢 (`sql/analytical_query.sql`)

此 SQL 查詢專為 PostgreSQL 優化，使用先進的視窗函數 (Window Functions) 處理時間分區與順序計算：
- **`ROW_NUMBER()`**：在每個玩家的每日分區內，按時間順序生成 1 開始的投注序號 (`play_seq`)。
- **`LAG()`**：分析連續的老虎機遊戲切換行為 (`is_game_changed`)。
- **`SUM() OVER`**：計算每日累計淨利潤曲線，並在日期或玩家改變時重置為 0。
- **`CAST`**：確保龐大的印尼盾 (IDR) 整數數值不會在呈現層被轉換為科學記號。

---

## 🐍 2. Python 本地分析引擎 (`python/analyzer.py`)

該指令碼使用 Pandas 在本地進行數據處理，並輸出一個自包含的 Plotly 互動式 HTML 圖表。

### 依賴安裝
請確保安裝了以下分析必備的 Python 函式庫：
```bash
pip install pandas numpy plotly
```

### 使用方法
1. **使用合成模擬數據運行**：
   ```bash
   python python/analyzer.py
   ```
   這將產生模擬日誌數據，執行分析運算，並匯出互動式圖表至 `player_profit_curve.html`。

2. **使用自訂日誌 CSV 檔案運行**：
   ```bash
   python python/analyzer.py --csv path/to/your_logs.csv --player 888001 --out output_chart.html
   ```

---

## 📊 3. 網頁互動式儀表板 (`web/index.html`)

使用原生 CSS 玻璃擬態設計的響應式單頁儀表板。它會動態渲染投注序列，並在圖表上以特殊標記顯示免費遊戲功能 (⭐) 與切換遊戲事件 (🔄)。

### 運行儀表板
您可以直接在瀏覽器中雙擊開啟 `web/index.html`，或者啟動一個本地網頁伺服器：
```bash
# Python 3 啟動方式
python -m http.server 8000
```
接著在瀏覽器中開啟 `http://localhost:8000/web/`。

*註：預設情況下，儀表板會以 **模擬預覽模式 (Synthetic Preview Mode)** 啟動，以便您立刻查看視覺美感、滑鼠懸停提示以及累計利潤曲線。您可以點選切換為 **"Upload Custom CSV Log"** 來上傳符合 schema 的真實 CSV 數據檔案。*
