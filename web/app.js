// iGaming 玩家投注行為分析儀表板前端邏輯 - 連接本地 PostgreSQL 後端

// 全域狀態變數
let analyzedData = [];      // 用於快取目前所選玩家在指定日期的所有旋轉紀錄
let currentLang = 'zh';     // 語系設定：預設為繁體中文 ('zh')，支援切換為英文 ('en')

// DOM 元素參考
const dateSelect = document.getElementById('date-select');
const playerSelect = document.getElementById('player-select');
const btnLangToggle = document.getElementById('btn-lang-toggle');
const checkboxNewPlayer = document.getElementById('checkbox-new-player');
const checkboxOldPlayer = document.getElementById('checkbox-old-player');
const checkboxWinPlayer = document.getElementById('checkbox-win-player');
const checkboxLosePlayer = document.getElementById('checkbox-lose-player');

// 指標數據顯示元素參考
const metricTotalSpins = document.getElementById('metric-total-spins');
const metricTotalWager = document.getElementById('metric-total-wager');
const metricTotalPayout = document.getElementById('metric-total-payout');
const metricNetProfit = document.getElementById('metric-net-profit');
const metricGameSwitches = document.getElementById('metric-game-switches');
const metricFreeGames = document.getElementById('metric-free-games');

// 數據明細表格本體
const tableBody = document.getElementById('table-body');

// ----------------------------------------------------
// 本地語系化字典 (i18n)
// ----------------------------------------------------
const translations = {
  en: {
    title: "iGaming Analytics",
    subtitle: "// Player Behavior Analyzer",
    legendCurve: "Cumulative Profit Curve",
    legendFg: "Free Game Marker",
    legendGs: "Game Switch Marker",
    filterTitle: "Filter Selection",
    labelActivePlayer: "Active Player ID",
    labelActiveDate: "Active Date (Partition)",
    labelFiltersTitle: "Player Filters",
    labelNewPlayer: "New Player",
    labelOldPlayer: "Old Player",
    labelWinPlayer: "Winning Player",
    labelLosePlayer: "Losing Player (Incl. Tie)",
    placeholderPlayer: "(Select date first)",
    placeholderDate: "(Loading dates...)",
    schemaTitle: "Target Schema Spec",
    schemaDesc: "Target table is <code>public.player_daily_flow_check</code> with the fields:",
    statSpins: "Daily Spins",
    statWager: "Total Wagered (IDR)",
    statPayout: "Total Payouts (IDR)",
    statNet: "Net Return (IDR)",
    statSwitches: "Game Switches",
    statFree: "Free Game Spins",
    tabTable: "📊 Sequence Output Table",
    thSeq: "Play Seq",
    thTime: "Timestamp (bet_at)",
    thSlot: "Slot ID",
    thBetType: "Bet Type",
    betTypeNormal: "normal bet",
    betTypeAnte: "ante bet",
    betTypeBuy: "buy feature",
    betTypeUnknown: "unknown ({type})",
    thSwitch: "Game Switch?",
    thFree: "Free Game?",
    thBet: "Bet (IDR)",
    thPrize: "Prize (IDR)",
    thNet: "Net Profit (IDR)",
    thCum: "Daily Cum Profit (IDR)",
    tdEmpty: "Please select a Date and Player ID from the filter sidebar.",
    badgeChanged: "🔄 Changed",
    badgeFree: "⭐ Free",
    btnCopySql: "Copy SQL",
    btnCopyPython: "Copy Python",
    // 圖表專用欄位
    chartTitle: "Player {player} Cumulative Profit Curve - {date}",
    chartXAxis: "Play Sequence Number (play_seq)",
    chartYAxis: "Cumulative Profit (IDR)",
    chartLegendProfit: "Cumulative Daily Profit",
    chartLegendFg: "Free Game Feature",
    chartLegendGs: "Game Switch",
    tooltipSeq: "Play Sequence",
    tooltipTime: "Time",
    tooltipSlot: "Game Slot ID",
    tooltipCumProfit: "Cumulative Profit",
    tooltipNetProfit: "Spin Net Profit",
    tooltipBet: "Bet",
    tooltipPrize: "Prize",
    tooltipFreeGame: "⭐ Free Game Spin",
    tooltipSwitch: "🔄 Switched Slot Game",
    tooltipNewGame: "New Game ID",
    tooltipCumShort: "Cum. Profit"
  },
  zh: {
    title: "iGaming 數據分析",
    subtitle: "// 玩家行為分析器",
    legendCurve: "累計利潤曲線",
    legendFg: "免費遊戲標記",
    legendGs: "切換遊戲標記",
    filterTitle: "篩選條件",
    labelActivePlayer: "當前玩家 ID",
    labelActiveDate: "當前日期 (分區)",
    labelFiltersTitle: "玩家篩選",
    labelNewPlayer: "新玩家",
    labelOldPlayer: "老玩家",
    labelWinPlayer: "贏錢玩家",
    labelLosePlayer: "輸錢玩家 (包含沒有輸贏)",
    placeholderPlayer: "(請先選擇日期)",
    placeholderDate: "(載入日期中...)",
    schemaTitle: "目標資料表 Schema",
    schemaDesc: "目標資料表為 <code>public.player_daily_flow_check</code>，欄位如下：",
    statSpins: "今日旋轉次數",
    statWager: "總投注額 (IDR)",
    statPayout: "總派彩額 (IDR)",
    statNet: "淨回報額 (IDR)",
    statSwitches: "遊戲切換次數",
    statFree: "免費遊戲次數",
    tabTable: "📊 序列輸出數據表",
    thSeq: "序號",
    thTime: "時間戳記 (bet_at)",
    thSlot: "遊戲 ID",
    thBetType: "投注類型",
    betTypeNormal: "一般投注 (normal bet)",
    betTypeAnte: "前置投注 (ante bet)",
    betTypeBuy: "購買特色 (buy feature)",
    betTypeUnknown: "未知 ({type})",
    thSwitch: "是否切換遊戲？",
    thFree: "是否免費？",
    thBet: "投注 (IDR)",
    thPrize: "派彩 (IDR)",
    thNet: "淨利 (IDR)",
    thCum: "每日累計利潤 (IDR)",
    tdEmpty: "請在左側篩選面板中選擇日期與玩家 ID。",
    badgeChanged: "🔄 已切換",
    badgeFree: "⭐ 免費",
    btnCopySql: "複製 SQL",
    btnCopyPython: "複製 Python",
    // 圖表專用欄位
    chartTitle: "玩家 {player} 累計利潤曲線 - {date}",
    chartXAxis: "投注序列號 (play_seq)",
    chartYAxis: "累計利潤 (IDR)",
    chartLegendProfit: "累計每日利潤",
    chartLegendFg: "免費遊戲特色",
    chartLegendGs: "切換遊戲",
    tooltipSeq: "投注序列",
    tooltipTime: "時間",
    tooltipSlot: "遊戲 Slot ID",
    tooltipCumProfit: "累計利潤",
    tooltipNetProfit: "旋轉淨利",
    tooltipBet: "投注",
    tooltipPrize: "派彩",
    tooltipFreeGame: "⭐ 免費旋轉",
    tooltipSwitch: "🔄 切換老虎機遊戲",
    tooltipNewGame: "新遊戲 ID",
    tooltipCumShort: "累計利潤"
  }
};

function updateLanguageUI() {
  """依據當前語系設定更新網頁上的所有文字欄位"""
  const lang = translations[currentLang];
  
  // 頁首 Header 區塊
  document.getElementById('nav-title').childNodes[0].textContent = lang.title + ' ';
  document.getElementById('nav-subtitle').textContent = lang.subtitle;
  document.getElementById('legend-curve').textContent = lang.legendCurve;
  document.getElementById('legend-fg').textContent = lang.legendFg;
  document.getElementById('legend-gs').textContent = lang.legendGs;
  
  // 篩選器面板區塊
  document.getElementById('filter-title').textContent = lang.filterTitle;
  document.getElementById('label-active-player').textContent = lang.labelActivePlayer;
  document.getElementById('label-active-date').textContent = lang.labelActiveDate;
  document.getElementById('label-filters-title').textContent = lang.labelFiltersTitle;
  document.getElementById('label-new-player').textContent = lang.labelNewPlayer;
  document.getElementById('label-old-player').textContent = lang.labelOldPlayer;
  document.getElementById('label-win-player').textContent = lang.labelWinPlayer;
  document.getElementById('label-lose-player').textContent = lang.labelLosePlayer;
  
  // 下拉選單預設選項
  const optPlaceholderDate = document.getElementById('opt-placeholder-date');
  if (optPlaceholderDate) {
    optPlaceholderDate.textContent = lang.placeholderDate;
  }
  const optPlaceholderPlayer = document.getElementById('opt-placeholder-player');
  if (optPlaceholderPlayer) {
    optPlaceholderPlayer.textContent = lang.placeholderPlayer;
  }
  
  // 六個指標看板 (Spins、Wager、Payout、Net、Switches、Free Spins)
  document.getElementById('label-stat-spins').textContent = lang.statSpins;
  document.getElementById('label-stat-wager').textContent = lang.statWager;
  document.getElementById('label-stat-payout').textContent = lang.statPayout;
  document.getElementById('label-stat-net').textContent = lang.statNet;
  document.getElementById('label-stat-switches').textContent = lang.statSwitches;
  document.getElementById('label-stat-free').textContent = lang.statFree;
  
  // 數據明細面板標題
  document.getElementById('table-panel-title').textContent = lang.tabTable;
  
  // 數據表表頭
  document.getElementById('th-seq').textContent = lang.thSeq;
  document.getElementById('th-time').textContent = lang.thTime;
  document.getElementById('th-slot').textContent = lang.thSlot;
  document.getElementById('th-bet-type').textContent = lang.thBetType;
  document.getElementById('th-switch').textContent = lang.thSwitch;
  document.getElementById('th-free').textContent = lang.thFree;
  document.getElementById('th-bet').textContent = lang.thBet;
  document.getElementById('th-prize').textContent = lang.thPrize;
  document.getElementById('th-net').textContent = lang.thNet;
  document.getElementById('th-cum').textContent = lang.thCum;
  
  // 數據表空資料列提示
  const tdEmpty = document.getElementById('td-empty');
  if (tdEmpty) {
    tdEmpty.textContent = lang.tdEmpty;
  }
}

// ----------------------------------------------------
// 使用者操作事件監聽 (Events Listeners)
// ----------------------------------------------------

// 點擊繁中/EN語系切換
btnLangToggle.addEventListener('click', () => {
  currentLang = currentLang === 'zh' ? 'en' : 'zh';
  updateLanguageUI();
  
  // 若已載入過資料，同步重新語系化下拉選單內「玩家 ID: X」的顯示字串
  const activeDate = dateSelect.value;
  const activePlayer = playerSelect.value;
  if (activeDate) {
    repopulatePlayerDropdown(activeDate, activePlayer);
  }
});

// 當前日期下拉選單改變，重新加載該日期的玩家 ID 清單
dateSelect.addEventListener('change', () => {
  const selectedDate = dateSelect.value;
  if (selectedDate) {
    loadPlayersForDate(selectedDate);
  } else {
    resetDashboardState();
  }
});

// 玩家 ID 下拉選單改變，重新載入該玩家的日投注明細
playerSelect.addEventListener('change', () => {
  const selectedDate = dateSelect.value;
  const selectedPlayer = playerSelect.value;
  if (selectedDate && selectedPlayer) {
    loadAnalyzedData(selectedDate, selectedPlayer);
  } else {
    resetDashboardState();
  }
});

// 篩選框互斥邏輯：新老互斥、贏輸互斥；狀態改變時即時更新玩家清單
checkboxNewPlayer.addEventListener('change', () => {
  if (checkboxNewPlayer.checked) checkboxOldPlayer.checked = false;
  const selectedDate = dateSelect.value;
  if (selectedDate) loadPlayersForDate(selectedDate);
});

checkboxOldPlayer.addEventListener('change', () => {
  if (checkboxOldPlayer.checked) checkboxNewPlayer.checked = false;
  const selectedDate = dateSelect.value;
  if (selectedDate) loadPlayersForDate(selectedDate);
});

checkboxWinPlayer.addEventListener('change', () => {
  if (checkboxWinPlayer.checked) checkboxLosePlayer.checked = false;
  const selectedDate = dateSelect.value;
  if (selectedDate) loadPlayersForDate(selectedDate);
});

checkboxLosePlayer.addEventListener('change', () => {
  if (checkboxLosePlayer.checked) checkboxWinPlayer.checked = false;
  const selectedDate = dateSelect.value;
  if (selectedDate) loadPlayersForDate(selectedDate);
});

// ----------------------------------------------------
// 後端 REST API 請求與串接
// ----------------------------------------------------

function loadAvailableDates() {
  """自 API /api/dates 獲取可選的分區日期清單，並預設加載首個日期"""
  fetch('/api/dates')
    .then(res => {
      if (!res.ok) {
        return res.json().then(data => { throw new Error(data.error || "伺服器錯誤"); });
      }
      return res.json();
    })
    .then(dates => {
      dateSelect.innerHTML = '';
      if (dates.length === 0) {
        const opt = document.createElement('option');
        opt.value = "";
        opt.textContent = currentLang === 'en' ? "No dates found in database" : "資料庫中無日期資料";
        dateSelect.appendChild(opt);
        return;
      }
      
      dates.forEach(d => {
        const opt = document.createElement('option');
        opt.value = d;
        opt.textContent = d;
        dateSelect.appendChild(opt);
      });
      
      // 自動觸發第一個日期的玩家 ID 查詢
      loadPlayersForDate(dates[0]);
    })
    .catch(err => {
      console.error("載入可用日期發生錯誤:", err);
      dateSelect.innerHTML = `<option value="">⚠️ ${err.message}</option>`;
      resetDashboardState();
    });
}

let activePlayersList = []; // 用於快取目前加載的玩家 ID 陣列

function loadPlayersForDate(date) {
  """依據當前選定的日期與 4 個篩選方塊狀態，獲取過濾後的玩家清單"""
  const newPlayer = checkboxNewPlayer.checked;
  const oldPlayer = checkboxOldPlayer.checked;
  const winPlayer = checkboxWinPlayer.checked;
  const losePlayer = checkboxLosePlayer.checked;
  
  const queryParams = new URLSearchParams({
    date: date,
    new_player: newPlayer,
    old_player: oldPlayer,
    win_player: winPlayer,
    lose_player: losePlayer
  });
  
  fetch(`/api/players?${queryParams.toString()}`)
    .then(res => {
      if (!res.ok) {
        return res.json().then(data => { throw new Error(data.error || "伺服器錯誤"); });
      }
      return res.json();
    })
    .then(players => {
      activePlayersList = players;
      repopulatePlayerDropdown(date, players[0]);
    })
    .catch(err => {
      console.error(`讀取日期 ${date} 的玩家清單失敗:`, err);
      playerSelect.innerHTML = `<option value="">⚠️ ${err.message}</option>`;
      resetDashboardState();
    });
}

function repopulatePlayerDropdown(date, selectPlayerId = null) {
  """重新將 activePlayersList 快取的資料填入玩家下拉選單中"""
  playerSelect.innerHTML = '';
  
  if (activePlayersList.length === 0) {
    const opt = document.createElement('option');
    opt.value = "";
    opt.textContent = currentLang === 'en' ? "(No players match filters)" : "(此條件下查無玩家)";
    playerSelect.appendChild(opt);
    resetDashboardState();
    return;
  }
  
  activePlayersList.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p;
    opt.textContent = currentLang === 'en' ? `Player ID: ${p}` : `玩家 ID: ${p}`;
    playerSelect.appendChild(opt);
  });
  
  // 保留或預設選擇指定玩家 ID
  if (selectPlayerId && activePlayersList.includes(String(selectPlayerId))) {
    playerSelect.value = String(selectPlayerId);
  } else {
    playerSelect.value = activePlayersList[0];
  }
  
  // 觸發該玩家與日期明細資料載入
  loadAnalyzedData(date, playerSelect.value);
}

function loadAnalyzedData(date, player_id) {
  """自 API /api/data 獲取指定日期和玩家的投注紀錄，並送入前端進行即時計算"""
  fetch(`/api/data?date=${date}&player_id=${player_id}`)
    .then(res => {
      if (!res.ok) {
        return res.json().then(data => { throw new Error(data.error || "伺服器錯誤"); });
      }
      return res.json();
    })
    .then(records => {
      processAndRender(records);
    })
    .catch(err => {
      console.error(`讀取玩家 ${player_id} 於日期 ${date} 的投注明細失敗:`, err);
      tableBody.innerHTML = `<tr><td colspan="10" style="text-align: center; color: var(--danger); font-weight: bold;">⚠️ 載入失敗: ${err.message}</td></tr>`;
    });
}

// ----------------------------------------------------
// 前端即時分析、運算與渲染
// ----------------------------------------------------

function processAndRender(records) {
  """對後端回傳的原始流水資料進行順序標記、切換檢測及累計利潤的即時運算"""
  if (records.length === 0) {
    resetDashboardState();
    return;
  }
  
  let playSeq = 0;
  let prevSlotId = null;
  let cumProfit = 0;
  
  // 將資料庫回傳的投注資訊映射為完整的分析特徵陣列
  analyzedData = records.map(record => {
    playSeq++;
    
    // 判斷是否發生切換老虎機遊戲 (比對上一次與本次的 slot_id)
    const slotId = Number(record.slot_id);
    let is_game_changed = false;
    if (prevSlotId !== null && prevSlotId !== slotId) {
      is_game_changed = true;
    }
    prevSlotId = slotId;
    
    // 計算該筆投注的淨利潤
    const bet = Number(record.bet_amount || 0);
    const prize = Number(record.total_prize || 0);
    const net_profit = prize - bet;
    cumProfit += net_profit; // 累加利潤
    
    return {
      play_seq: playSeq,
      bet_at: new Date(record.bet_at),
      slot_id: slotId,
      bet_type: record.bet_type,
      is_game_changed: is_game_changed,
      has_free_game: Boolean(record.has_free_game),
      bet_amount: bet,
      total_prize: prize,
      net_profit: net_profit,
      daily_cum_profit: cumProfit
    };
  });
  
  renderDashboard();
}

function renderDashboard() {
  """將計算後的分析數據更新至前端看板指標與結果表格，並呼叫 Plotly 繪圖"""
  if (analyzedData.length === 0) return;
  
  const player = playerSelect.value;
  const date = dateSelect.value;
  const lang = translations[currentLang];
  
  // 計算匯總看板指標
  let totalSpins = analyzedData.length;
  let totalWager = 0;
  let totalPayout = 0;
  let gameSwitches = 0;
  let freeGames = 0;
  
  analyzedData.forEach(row => {
    totalWager += row.bet_amount;
    totalPayout += row.total_prize;
    if (row.is_game_changed) gameSwitches++;
    if (row.has_free_game) freeGames++;
  });
  
  const netReturn = totalPayout - totalWager;
  
  // 渲染六大指標 counters，採用千分位金流格式化
  metricTotalSpins.textContent = totalSpins;
  metricTotalWager.textContent = formatCurrency(totalWager);
  metricTotalPayout.textContent = formatCurrency(totalPayout);
  
  metricNetProfit.textContent = formatCurrency(netReturn);
  metricNetProfit.className = 'metric-value ' + (netReturn >= 0 ? 'profit-positive' : 'profit-negative');
  
  metricGameSwitches.textContent = gameSwitches;
  metricFreeGames.textContent = freeGames;
  
  // 清空數據表格並逐列渲染填入明細
  tableBody.innerHTML = '';
  analyzedData.forEach(row => {
    const tr = document.createElement('tr');
    
    // 是否切換遊戲事件狀態標籤
    const isSwitchedCell = row.is_game_changed 
      ? `<span class="badge badge-game-changed">${lang.badgeChanged}</span>` 
      : `<span style="color:var(--text-secondary);">--</span>`;
      
    // 是否為免費遊戲狀態標籤
    const isFreeCell = row.has_free_game 
      ? `<span class="badge badge-free-game">${lang.badgeFree}</span>` 
      : `<span style="color:var(--text-secondary);">--</span>`;
      
    // 淨利數值與正負顏色 class 決定
    const spinNet = row.net_profit;
    const netClass = spinNet > 0 ? 'color: var(--success);' : (spinNet < 0 ? 'color: var(--danger);' : '');
    const timestampStr = row.bet_at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    
    // 投注類型代碼映射為文字字串
    let betTypeStr = '--';
    if (row.bet_type !== undefined && row.bet_type !== null) {
      const bType = Number(row.bet_type);
      if (bType === 1) {
        betTypeStr = lang.betTypeNormal;
      } else if (bType === 2) {
        betTypeStr = lang.betTypeAnte;
      } else if (bType === 3) {
        betTypeStr = lang.betTypeBuy;
      } else {
        betTypeStr = lang.betTypeUnknown.replace('{type}', bType);
      }
    }
    
    tr.innerHTML = `
      <td style="font-family: var(--font-mono); font-weight:600;">#${row.play_seq}</td>
      <td style="color: var(--text-secondary);">${timestampStr}</td>
      <td style="font-family: var(--font-mono);">${row.slot_id}</td>
      <td style="font-size: 0.85rem;">${betTypeStr}</td>
      <td>${isSwitchedCell}</td>
      <td>${isFreeCell}</td>
      <td>${formatCurrency(row.bet_amount)}</td>
      <td>${formatCurrency(row.total_prize)}</td>
      <td style="${netClass}">${spinNet > 0 ? '+' : ''}${formatCurrency(spinNet)}</td>
      <td style="font-family: var(--font-mono); font-weight:bold; ${row.daily_cum_profit >= 0 ? 'color: var(--success)' : 'color: var(--danger)'}">
        ${formatCurrency(row.daily_cum_profit)}
      </td>
    `;
    tableBody.appendChild(tr);
  });
  
  // 渲染 Plotly 圖表
  renderPlotlyChart(analyzedData, player, date);
}

function renderPlotlyChart(chartData, player, date) {
  """使用 Plotly.js 對分析後的數據點進行渲染，包含 Tooltips 進階顯示"""
  const lang = translations[currentLang];
  const xData = chartData.map(r => r.play_seq);
  const yData = chartData.map(r => r.daily_cum_profit);

  // 1. 設置利潤曲線基本折線 Trace
  const profitTrace = {
    x: xData,
    y: yData,
    mode: 'lines+markers',
    name: lang.chartLegendProfit,
    line: {
      color: '#6366f1',
      width: 3.5,
      shape: 'linear'
    },
    marker: {
      size: 5,
      color: '#818cf8'
    },
    // 將多個欄位傳入 customdata 中以供 Hover Tooltip 使用
    customdata: chartData.map(r => {
      let betTypeStr = '--';
      if (r.bet_type !== undefined && r.bet_type !== null) {
        const bType = Number(r.bet_type);
        if (bType === 1) {
          betTypeStr = lang.betTypeNormal;
        } else if (bType === 2) {
          betTypeStr = lang.betTypeAnte;
        } else if (bType === 3) {
          betTypeStr = lang.betTypeBuy;
        } else {
          betTypeStr = lang.betTypeUnknown.replace('{type}', bType);
        }
      }
      return [
        formatCurrency(r.net_profit),
        formatCurrency(r.bet_amount),
        formatCurrency(r.total_prize),
        r.slot_id,
        r.bet_at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        betTypeStr
      ];
    }),
    hovertemplate: 
      `<b>${lang.tooltipSeq}:</b> #%{x}<br>` +
      `<b>${lang.tooltipTime}:</b> %{customdata[4]}<br>` +
      `<b>${lang.thBetType}:</b> %{customdata[5]}<br>` +
      `<b>${lang.tooltipSlot}:</b> %{customdata[3]}<br>` +
      `<b>${lang.tooltipCumProfit}:</b> %{y:,.0f} IDR<br>` +
      `<b>${lang.tooltipNetProfit}:</b> %{customdata[0]}<br>` +
      `<b>${lang.tooltipBet}:</b> %{customdata[1]} | <b>${lang.tooltipPrize}:</b> %{customdata[2]}<br>` +
      "<extra></extra>",
    type: 'scatter'
  };

  // 2. 設置免費遊戲標記點 Trace (has_free_game = True)
  const fgDataset = chartData.filter(r => r.has_free_game);
  const freeGameTrace = {
    x: fgDataset.map(r => r.play_seq),
    y: fgDataset.map(r => r.daily_cum_profit),
    mode: 'markers',
    name: lang.chartLegendFg,
    marker: {
      symbol: 'star',
      size: 13,
      color: '#10b981',
      line: {
        color: '#ffffff',
        width: 1.5
      }
    },
    hovertemplate: 
      `<b>${lang.tooltipFreeGame}</b><br>` +
      `${lang.tooltipSeq}: #%{x}<br>` +
      `${lang.tooltipCumShort}: %{y:,.0f} IDR<br>` +
      "<extra></extra>",
    type: 'scatter'
  };

  // 3. 設置切換遊戲標記點 Trace (is_game_changed = True)
  const gsDataset = chartData.filter(r => r.is_game_changed);
  const gameSwitchTrace = {
    x: gsDataset.map(r => r.play_seq),
    y: gsDataset.map(r => r.daily_cum_profit),
    mode: 'markers',
    name: lang.chartLegendGs,
    marker: {
      symbol: 'diamond',
      size: 12,
      color: '#f59e0b',
      line: {
        color: '#ffffff',
        width: 1.5
      }
    },
    hovertemplate: 
      `<b>${lang.tooltipSwitch}</b><br>` +
      `${lang.tooltipSeq}: #%{x}<br>` +
      `${lang.tooltipNewGame}: %{text}<br>` +
      `${lang.tooltipCumShort}: %{y:,.0f} IDR<br>` +
      "<extra></extra>",
    text: gsDataset.map(r => r.slot_id),
    type: 'scatter'
  };

  // 圖表版面與樣式細部設定 (對齊玻璃擬態 Cyber-Dark 面板風格)
  const layout = {
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(15, 23, 42, 0.4)',
    margin: { l: 80, r: 40, t: 50, b: 50 },
    title: {
      text: lang.chartTitle.replace('{player}', player).replace('{date}', date),
      font: {
        color: '#f3f4f6',
        family: 'Outfit, sans-serif',
        size: 16
      }
    },
    xaxis: {
      title: lang.chartXAxis,
      gridcolor: 'rgba(255,255,255,0.05)',
      tickfont: { color: '#94a3b8' },
      titlefont: { color: '#94a3b8' },
      zerolinecolor: 'rgba(255,255,255,0.1)'
    },
    yaxis: {
      title: lang.chartYAxis,
      gridcolor: 'rgba(255,255,255,0.05)',
      tickfont: { color: '#94a3b8' },
      titlefont: { color: '#94a3b8' },
      zerolinecolor: 'rgba(255,255,255,0.1)',
      tickformat: ',' // 大金額格式化
    },
    legend: {
      font: { color: '#94a3b8' },
      bgcolor: 'rgba(15, 23, 42, 0.95)',
      bordercolor: 'rgba(255,255,255,0.05)',
      borderwidth: 1
    },
    hovermode: 'closest'
  };

  const config = {
    responsive: true,
    displayModeBar: true,
    displaylogo: false,
    modeBarButtonsToRemove: ['select2d', 'lasso2d', 'toggleSpikelines']
  };

  const dataTraces = [profitTrace];
  if (fgDataset.length > 0) dataTraces.push(freeGameTrace);
  if (gsDataset.length > 0) dataTraces.push(gameSwitchTrace);

  Plotly.newPlot('chart-viewport', dataTraces, layout, config);
}

function resetDashboardState() {
  """重置清空目前指標數據看板、表格與圖表至初始狀態"""
  analyzedData = [];
  
  metricTotalSpins.textContent = "0";
  metricTotalWager.textContent = "0 IDR";
  metricTotalPayout.textContent = "0 IDR";
  metricNetProfit.textContent = "0 IDR";
  metricNetProfit.className = 'metric-value';
  metricGameSwitches.textContent = "0";
  metricFreeGames.textContent = "0";
  
  tableBody.innerHTML = `
    <tr>
      <td id="td-empty" colspan="10" style="text-align: center; color: var(--text-secondary); padding: 2rem;">
        ${translations[currentLang].tdEmpty}
      </td>
    </tr>
  `;
  
  const gd = document.getElementById('chart-viewport');
  if (gd && gd.layout) {
    Plotly.purge(gd);
  }
}

// 格式化貨幣金流為千分位，並加上 IDR 尾碼
function formatCurrency(val) {
  return new Intl.NumberFormat('en-US', {
    style: 'decimal',
    maximumFractionDigits: 0
  }).format(val) + " IDR";
}

// 網頁加載完成後自動運行初始化
window.addEventListener('DOMContentLoaded', () => {
  updateLanguageUI();
  loadAvailableDates();
});
