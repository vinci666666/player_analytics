// iGaming 玩家投注行為分析儀表板前端邏輯 - 連接本地 PostgreSQL 後端

// 全域狀態變數
let analyzedData = [];      // 用於快取目前所選玩家在指定日期的所有旋轉紀錄
let currentLang = 'zh';     // 語系設定：預設為繁體中文 ('zh')，支援切換為英文 ('en')
let currentPlayersRequestController = null;

// DOM 元素參考
const dateModeSelect = document.getElementById('date-mode-select');
const containerSingleDate = document.getElementById('container-single-date');
const containerRangeDate = document.getElementById('container-range-date');
const dateSelect = document.getElementById('date-select');
const dateStartSelect = document.getElementById('date-start-select');
const dateEndSelect = document.getElementById('date-end-select');
const minSpinsInput = document.getElementById('input-min-spins');
const maxSpinsInput = document.getElementById('input-max-spins');
const playerSelect = document.getElementById('player-select');
const btnLangToggle = document.getElementById('btn-lang-toggle');
const btnApplyFilters = document.getElementById('btn-apply-filters');
const checkboxNewPlayer = document.getElementById('checkbox-new-player');
const checkboxOldPlayer = document.getElementById('checkbox-old-player');
const checkboxWinPlayer = document.getElementById('checkbox-win-player');
const checkboxLosePlayer = document.getElementById('checkbox-lose-player');

// 指標數據顯示元素參考
const metricStatsSpins = document.getElementById('metric-stats-spins');
const metricStatsTotalWager = document.getElementById('metric-stats-total-wager');
const metricStatsTotalPayout = document.getElementById('metric-stats-total-payout');
const metricStatsNetProfit = document.getElementById('metric-stats-net-profit');
const metricStatsFirstSpin = document.getElementById('metric-stats-first-spin');
const metricStatsLastUpdate = document.getElementById('metric-stats-last-update');
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
    labelActiveDate: "Selected Date",
    labelFiltersTitle: "Player Filters",
    labelNewPlayer: "New Player",
    labelOldPlayer: "Old Player",
    labelWinPlayer: "Winning Player",
    labelLosePlayer: "Losing Player (Incl. Tie)",
    placeholderPlayer: "(Select date first)",
    placeholderDate: "(Loading dates...)",
    labelDateMode: "Date Filter Mode",
    optDateModeSingle: "Single Date",
    optDateModeRange: "Time Interval",
    labelStartDate: "Start Date",
    labelEndDate: "End Date",
    labelMinSpins: "Min Spin Count",
    labelMaxSpins: "Max Spin Count",
    labelApplyFilters: "Apply Filters",
    placeholderApplyFilters: "(Click Apply Filters to load players)",
    placeholderLoadingPlayers: "(Loading players...)",
    filterTimeoutMessage: "Request timed out after 30 seconds. Please apply filters again.",
    schemaTitle: "Target Schema Spec",
    schemaDesc: "Target table is <code>public.slot_parent_bet</code> with the fields:",
    metricsPlayerTitle: "Player Total Info",
    metricsRangeTitle: "Range Info",
    statTotalSpins: "Total Spins",
    statTotalWager: "Total Wagered (IDR)",
    statTotalPayout: "Total Payouts (IDR)",
    statTotalNet: "Net Return (IDR)",
    statFirstSpin: "First Spin Date",
    statLastUpdate: "Last Update Time",
    statSpins: "Range Spins",
    statWager: "Range Wagered (IDR)",
    statPayout: "Range Payouts (IDR)",
    statNet: "Range Net Return (IDR)",
    statSwitches: "Game Switches",
    statFree: "Free Game Spins",
    tabTable: "📊 Sequence Output Table",
    thSeq: "Play Seq",
    thPlayer: "Player ID",
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
    labelActiveDate: "選擇日期",
    labelFiltersTitle: "玩家篩選",
    labelNewPlayer: "新玩家",
    labelOldPlayer: "老玩家",
    labelWinPlayer: "贏錢玩家",
    labelLosePlayer: "輸錢玩家 (包含沒有輸贏)",
    placeholderPlayer: "(請先選擇日期)",
    placeholderDate: "(載入日期中...)",
    labelDateMode: "日期篩選模式",
    optDateModeSingle: "選擇日期 (單日)",
    optDateModeRange: "時間區間 (範圍)",
    labelStartDate: "開始日期",
    labelEndDate: "結束日期",
    labelMinSpins: "最小 Spin 數",
    labelMaxSpins: "最大 Spin 數",
    labelApplyFilters: "篩選",
    placeholderApplyFilters: "(請按篩選載入玩家)",
    placeholderLoadingPlayers: "(玩家載入中...)",
    filterTimeoutMessage: "本次請求已超過 30 秒並取消，請再次按篩選。",
    schemaTitle: "目標資料表 Schema",
    schemaDesc: "目標資料表為 <code>public.slot_parent_bet</code>，欄位如下：",
    metricsPlayerTitle: "玩家總資訊",
    metricsRangeTitle: "玩家範圍內資訊",
    statTotalSpins: "旋轉次數",
    statTotalWager: "總投注額 (IDR)",
    statTotalPayout: "總派彩額 (IDR)",
    statTotalNet: "淨回報額 (IDR)",
    statFirstSpin: "第一次 Spin 日期",
    statLastUpdate: "最後更新時間",
    statSpins: "範圍內旋轉次數",
    statWager: "範圍內總投注額 (IDR)",
    statPayout: "範圍內總派彩額 (IDR)",
    statNet: "範圍內淨回報額 (IDR)",
    statSwitches: "遊戲切換次數",
    statFree: "免費遊戲次數",
    tabTable: "📊 序列輸出數據表",
    thSeq: "序號",
    thPlayer: "玩家 ID",
    thTime: "時間戳記 (bet_at)",
    thSlot: "遊戲 ID",
    thBetType: "投注類型",
    betTypeNormal: "一般投注",
    betTypeAnte: "前置投注",
    betTypeBuy: "購買特色",
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
  // 依據當前語系設定更新網頁上的所有文字欄位
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
  
  // 新篩選器元素
  document.getElementById('label-date-mode').textContent = lang.labelDateMode;
  document.getElementById('opt-date-mode-single').textContent = lang.optDateModeSingle;
  document.getElementById('opt-date-mode-range').textContent = lang.optDateModeRange;
  document.getElementById('label-start-date').textContent = lang.labelStartDate;
  document.getElementById('label-end-date').textContent = lang.labelEndDate;
  document.getElementById('label-min-spins').textContent = lang.labelMinSpins;
  document.getElementById('label-max-spins').textContent = lang.labelMaxSpins;
  document.getElementById('label-apply-filters').textContent = lang.labelApplyFilters;
  
  // 下拉選單預設選項
  const optPlaceholderDate = document.getElementById('opt-placeholder-date');
  if (optPlaceholderDate) {
    optPlaceholderDate.textContent = lang.placeholderDate;
  }
  const optPlaceholderPlayer = document.getElementById('opt-placeholder-player');
  if (optPlaceholderPlayer) {
    optPlaceholderPlayer.textContent = lang.placeholderPlayer;
  }
  
  // 指標看板
  document.getElementById('metrics-player-title').textContent = lang.metricsPlayerTitle;
  document.getElementById('metrics-range-title').textContent = lang.metricsRangeTitle;
  document.getElementById('label-stat-total-spins').textContent = lang.statTotalSpins;
  document.getElementById('label-stat-total-wager').textContent = lang.statTotalWager;
  document.getElementById('label-stat-total-payout').textContent = lang.statTotalPayout;
  document.getElementById('label-stat-total-net').textContent = lang.statTotalNet;
  document.getElementById('label-stat-first-spin').textContent = lang.statFirstSpin;
  document.getElementById('label-stat-last-update').textContent = lang.statLastUpdate;
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
  document.getElementById('th-player').textContent = lang.thPlayer;
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
  const mode = dateModeSelect.value;
  let startDate, endDate;
  if (mode === 'single') {
    startDate = dateSelect.value;
    endDate = dateSelect.value;
  } else {
    startDate = dateStartSelect.value;
    endDate = dateEndSelect.value;
  }
  const activePlayer = playerSelect.value;
  if (startDate && endDate && activePlayersList.length > 0) {
    repopulatePlayerDropdown(startDate, endDate, activePlayer);
  } else if (startDate && endDate) {
    markFiltersPending();
  }
});

// 當前日期篩選模式變更
dateModeSelect.addEventListener('change', () => {
  const mode = dateModeSelect.value;
  if (mode === 'single') {
    containerSingleDate.style.display = 'block';
    containerRangeDate.style.display = 'none';
  } else {
    containerSingleDate.style.display = 'none';
    containerRangeDate.style.display = 'block';
  }
  markFiltersPending();
});

// 各個日期下拉選單改變，只標記待篩選；按下篩選按鈕才重新加載玩家 ID 清單
dateSelect.addEventListener('change', () => {
  markFiltersPending();
});
dateStartSelect.addEventListener('change', () => {
  markFiltersPending();
});
dateEndSelect.addEventListener('change', () => {
  markFiltersPending();
});

// Spin 數範圍輸入框改變，只標記待篩選；按下篩選按鈕才重新加載玩家 ID 清單
minSpinsInput.addEventListener('change', () => {
  normalizeSpinRangeInputs();
  markFiltersPending();
});

maxSpinsInput.addEventListener('change', () => {
  normalizeSpinRangeInputs();
  markFiltersPending();
});

btnApplyFilters.addEventListener('click', () => {
  normalizeSpinRangeInputs();
  triggerLoadPlayers();
});

// 玩家 ID 下拉選單改變，重新載入該玩家的投注區間明細
playerSelect.addEventListener('change', () => {
  const mode = dateModeSelect.value;
  let startDate, endDate;
  if (mode === 'single') {
    startDate = dateSelect.value;
    endDate = dateSelect.value;
  } else {
    startDate = dateStartSelect.value;
    endDate = dateEndSelect.value;
  }
  const selectedPlayer = playerSelect.value;
  if (startDate && endDate && selectedPlayer) {
    loadAnalyzedData(startDate, endDate, selectedPlayer);
  } else {
    resetDashboardState();
  }
});

// 篩選框互斥邏輯：新老互斥、贏輸互斥；狀態改變時等待使用者按篩選
checkboxNewPlayer.addEventListener('change', () => {
  if (checkboxNewPlayer.checked) checkboxOldPlayer.checked = false;
  markFiltersPending();
});

checkboxOldPlayer.addEventListener('change', () => {
  if (checkboxOldPlayer.checked) checkboxNewPlayer.checked = false;
  markFiltersPending();
});

checkboxWinPlayer.addEventListener('change', () => {
  if (checkboxWinPlayer.checked) checkboxLosePlayer.checked = false;
  markFiltersPending();
});

checkboxLosePlayer.addEventListener('change', () => {
  if (checkboxLosePlayer.checked) checkboxWinPlayer.checked = false;
  markFiltersPending();
});

// ----------------------------------------------------
// 後端 REST API 請求與串接
// ----------------------------------------------------

function loadAvailableDates() {
  // 自 API /api/dates 獲取可選的分區日期清單，並預設加載首個日期
  fetch('/api/dates')
    .then(res => {
      if (!res.ok) {
        return res.json().then(data => { throw new Error(data.error || "伺服器錯誤"); });
      }
      return res.json();
    })
    .then(dates => {
      dateSelect.innerHTML = '';
      dateStartSelect.innerHTML = '';
      dateEndSelect.innerHTML = '';
      
      if (dates.length === 0) {
        const errMsg = currentLang === 'en' ? "No dates found in database" : "資料庫中無日期資料";
        [dateSelect, dateStartSelect, dateEndSelect].forEach(sel => {
          const opt = document.createElement('option');
          opt.value = "";
          opt.textContent = errMsg;
          sel.appendChild(opt);
        });
        return;
      }
      
      dates.forEach(d => {
        // 單一日期
        const opt = document.createElement('option');
        opt.value = d;
        opt.textContent = d;
        dateSelect.appendChild(opt);
        
        // 開始日期
        const optStart = document.createElement('option');
        optStart.value = d;
        optStart.textContent = d;
        dateStartSelect.appendChild(optStart);
        
        // 結束日期
        const optEnd = document.createElement('option');
        optEnd.value = d;
        optEnd.textContent = d;
        dateEndSelect.appendChild(optEnd);
      });
      
      // 設定預設值：單一日期與結束日期為最新日期，開始日期為最新日期往前一個月內的最早可選日期
      dateSelect.value = dates[0];
      dateEndSelect.value = dates[0];
      dateStartSelect.value = getDefaultRangeStartDate(dates, dates[0]);
      
      markFiltersPending();
    })
    .catch(err => {
      console.error("載入可用日期發生錯誤:", err);
      const errMsg = `⚠️ ${err.message}`;
      [dateSelect, dateStartSelect, dateEndSelect].forEach(sel => {
        sel.innerHTML = `<option value="">${errMsg}</option>`;
      });
      resetDashboardState();
    });
}

function triggerLoadPlayers() {
  const mode = dateModeSelect.value;
  let startDate, endDate;
  if (mode === 'single') {
    startDate = dateSelect.value;
    endDate = dateSelect.value;
  } else {
    startDate = dateStartSelect.value;
    endDate = dateEndSelect.value;
  }
  
  if (!startDate || !endDate) {
    resetDashboardState();
    return;
  }
  
  // 日期區間合法性驗證 (開始日期不得大於結束日期)
  if (startDate > endDate) {
    playerSelect.innerHTML = `<option value="">${currentLang === 'en' ? "⚠️ Start date must be before or equal to End date" : "⚠️ 開始日期必須小於或等於結束日期"}</option>`;
    resetDashboardState();
    return;
  }

  if (mode === 'range' && isDateRangeOverOneMonth(startDate, endDate)) {
    playerSelect.innerHTML = `<option value="">${currentLang === 'en' ? "⚠️ Time interval must be within one month" : "⚠️ 時間區間不可超過一個月"}</option>`;
    resetDashboardState();
    return;
  }
  
  loadPlayersForDate(startDate, endDate);
}

let activePlayersList = []; // 用於快取目前加載的玩家 ID 陣列

function markFiltersPending() {
  activePlayersList = [];
  playerSelect.innerHTML = `<option value="" id="opt-placeholder-player">${translations[currentLang].placeholderApplyFilters}</option>`;
  resetDashboardState();
}

function setFilterLoading(isLoading) {
  btnApplyFilters.disabled = isLoading;
  btnApplyFilters.style.opacity = isLoading ? '0.7' : '';
  btnApplyFilters.style.cursor = isLoading ? 'not-allowed' : '';
  document.getElementById('label-apply-filters').textContent = isLoading
    ? (currentLang === 'en' ? 'Loading...' : '載入中...')
    : translations[currentLang].labelApplyFilters;
}

function loadPlayersForDate(startDate, endDate) {
  // 依據當前選定的日期與 4 個篩選方塊狀態，獲取過濾後的玩家清單
  const newPlayer = checkboxNewPlayer.checked;
  const oldPlayer = checkboxOldPlayer.checked;
  const winPlayer = checkboxWinPlayer.checked;
  const losePlayer = checkboxLosePlayer.checked;
  const minSpins = getMinSpinsValue();
  const maxSpins = getMaxSpinsValue();
  
  const queryParams = new URLSearchParams({
    start_date: startDate,
    end_date: endDate,
    new_player: newPlayer,
    old_player: oldPlayer,
    win_player: winPlayer,
    lose_player: losePlayer,
    min_spins: minSpins,
    max_spins: maxSpins
  });

  if (currentPlayersRequestController) {
    currentPlayersRequestController.abort();
  }
  currentPlayersRequestController = new AbortController();
  const requestController = currentPlayersRequestController;
  const timeoutId = setTimeout(() => {
    requestController.abort();
  }, 30000);

  activePlayersList = [];
  playerSelect.innerHTML = `<option value="">${translations[currentLang].placeholderLoadingPlayers}</option>`;
  resetDashboardState();
  setFilterLoading(true);
  
  fetch(`/api/players?${queryParams.toString()}`, { signal: requestController.signal })
    .then(res => {
      if (!res.ok) {
        return res.json().then(data => { throw new Error(data.error || "伺服器錯誤"); });
      }
      return res.json();
    })
    .then(players => {
      if (currentPlayersRequestController !== requestController) return;
      activePlayersList = players;
      repopulatePlayerDropdown(startDate, endDate, players[0]);
    })
    .catch(err => {
      if (err.name === 'AbortError' && currentPlayersRequestController !== requestController) return;
      const message = err.name === 'AbortError'
        ? translations[currentLang].filterTimeoutMessage
        : err.message;
      console.error(`讀取日期範圍 ${startDate} ~ ${endDate} 的玩家清單失敗:`, err);
      playerSelect.innerHTML = `<option value="">⚠️ ${message}</option>`;
      resetDashboardState();
    })
    .finally(() => {
      clearTimeout(timeoutId);
      if (currentPlayersRequestController === requestController) {
        currentPlayersRequestController = null;
        setFilterLoading(false);
      }
    });
}

function repopulatePlayerDropdown(startDate, endDate, selectPlayerId = null) {
  // 重新將 activePlayersList 快取的資料填入玩家下拉選單中
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
    playerSelect.value = String(activePlayersList[0]);
  }
  
  // 觸發該玩家與日期明細資料載入
  loadAnalyzedData(startDate, endDate, playerSelect.value);
}

function loadAnalyzedData(startDate, endDate, player_id) {
  if (!player_id) {
    resetDashboardState();
    return;
  }
  
  const newPlayer = checkboxNewPlayer.checked;
  const oldPlayer = checkboxOldPlayer.checked;
  const winPlayer = checkboxWinPlayer.checked;
  const losePlayer = checkboxLosePlayer.checked;
  const minSpins = getMinSpinsValue();
  const maxSpins = getMaxSpinsValue();
  
  const queryParams = new URLSearchParams({
    start_date: startDate,
    end_date: endDate,
    player_id: player_id
  });
  
  queryParams.set('new_player', newPlayer);
  queryParams.set('old_player', oldPlayer);
  queryParams.set('win_player', winPlayer);
  queryParams.set('lose_player', losePlayer);
  queryParams.set('min_spins', minSpins);
  queryParams.set('max_spins', maxSpins);
  
  // 自 API /api/data 獲取指定日期和玩家的投注紀錄，並送入前端進行即時計算
  fetch(`/api/data?${queryParams.toString()}`)
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
      console.error(`讀取玩家 ${player_id} 於日期範圍 ${startDate} ~ ${endDate} 的投注明細失敗:`, err);
      tableBody.innerHTML = `<tr><td colspan="11" style="text-align: center; color: var(--danger); font-weight: bold;">⚠️ 載入失敗: ${err.message}</td></tr>`;
    });
}

// ----------------------------------------------------
// 前端即時分析、運算與渲染
// ----------------------------------------------------

function processAndRender(records) {
  // 對後端回傳的原始流水資料進行順序標記、切換檢測及累計利潤的即時運算
  if (records.length === 0) {
    resetDashboardState();
    return;
  }
  
  const playerStates = new Map();
  
  // 將資料庫回傳的投注資訊映射為完整的分析特徵陣列
  analyzedData = records.map(record => {
    const playerId = String(record.player_id);
    const state = playerStates.get(playerId) || {
      playSeq: 0,
      prevSlotId: null,
      cumProfit: 0
    };
    state.playSeq++;
    
    // 判斷是否發生切換老虎機遊戲 (比對上一次與本次的 slot_id)
    const slotId = Number(record.slot_id);
    let is_game_changed = false;
    if (state.prevSlotId !== null && state.prevSlotId !== slotId) {
      is_game_changed = true;
    }
    state.prevSlotId = slotId;
    
    // 計算該筆投注的淨利潤
    const bet = Number(record.bet_amount || 0);
    const prize = Number(record.total_prize || 0);
    const net_profit = prize - bet;
    state.cumProfit += net_profit; // 累加利潤
    playerStates.set(playerId, state);
    
    return {
      play_seq: state.playSeq,
      player_id: playerId,
      bet_at: new Date(record.bet_at),
      slot_id: slotId,
      bet_type: record.bet_type,
      is_game_changed: is_game_changed,
      has_free_game: Boolean(record.has_free_game),
      bet_amount: bet,
      total_prize: prize,
      stats_first_spin_date: record.stats_first_spin_date,
      stats_total_bet_amount: parseNullableNumber(record.stats_total_bet_amount),
      stats_total_win_amount: parseNullableNumber(record.stats_total_win_amount),
      stats_spin_count: parseNullableNumber(record.stats_spin_count),
      stats_last_spin_at: record.stats_last_spin_at,
      net_profit: net_profit,
      daily_cum_profit: state.cumProfit
    };
  });
  
  renderDashboard();
}

function renderDashboard() {
  // 將計算後的分析數據更新至前端看板指標與結果表格，並呼叫 Plotly 繪圖
  if (analyzedData.length === 0) return;
  
  const player = playerSelect.value;
  const mode = dateModeSelect.value;
  let dateText = '';
  if (mode === 'single') {
    dateText = dateSelect.value;
  } else {
    dateText = `${dateStartSelect.value} ~ ${dateEndSelect.value}`;
  }
  
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
  
  const statsRow = analyzedData[0];
  const statsNetReturn = statsRow.stats_total_win_amount === null || statsRow.stats_total_bet_amount === null
    ? null
    : statsRow.stats_total_win_amount - statsRow.stats_total_bet_amount;

  metricStatsSpins.textContent = formatCount(statsRow.stats_spin_count);
  metricStatsTotalWager.textContent = formatNullableCurrency(statsRow.stats_total_bet_amount);
  metricStatsTotalPayout.textContent = formatNullableCurrency(statsRow.stats_total_win_amount);
  metricStatsNetProfit.textContent = formatNullableCurrency(statsNetReturn);
  metricStatsNetProfit.className = 'metric-value ' + getProfitClass(statsNetReturn);
  metricStatsFirstSpin.textContent = statsRow.stats_first_spin_date || "--";
  metricStatsLastUpdate.textContent = formatDateTimeText(statsRow.stats_last_spin_at);

  // 渲染範圍內指標 counters，採用千分位金流格式化
  metricTotalSpins.textContent = totalSpins;
  metricTotalWager.textContent = formatCurrency(totalWager);
  metricTotalPayout.textContent = formatCurrency(totalPayout);
  
  metricNetProfit.textContent = formatCurrency(netReturn);
  metricNetProfit.className = 'metric-value ' + (netReturn >= 0 ? 'profit-positive' : 'profit-negative');
  
  metricGameSwitches.textContent = gameSwitches;
  metricFreeGames.textContent = freeGames;
  
  // 清空數據表格並逐列渲染填入明細 (限制最高 5,000 筆以防 DOM 凍結)
  tableBody.innerHTML = '';
  const MAX_TABLE_ROWS = 5000;
  const rowsToRender = analyzedData.slice(0, MAX_TABLE_ROWS);
  
  rowsToRender.forEach(row => {
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
    const timestampStr = formatDateTimeForTooltip(row.bet_at);
    
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
      <td style="font-family: var(--font-mono); color: #818cf8;">${row.player_id}</td>
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
  
  // 若筆數超出限制，於底部顯示提示
  if (analyzedData.length > MAX_TABLE_ROWS) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td colspan="11" style="text-align: center; color: var(--warning); font-weight: bold; padding: 1rem; background: rgba(245, 158, 11, 0.05);">
        ⚠️ ${currentLang === 'en' ? `Showing first 5,000 of ${analyzedData.length} records. Please narrow down date interval or adjust spin range.` : `僅顯示前 5,000 筆紀錄（共 ${analyzedData.length} 筆）。請縮小時間區間或調整 Spin 範圍以精簡資料。`}
      </td>
    `;
    tableBody.appendChild(tr);
  }
  
  // 渲染 Plotly 圖表
  renderPlotlyChart(analyzedData, player, dateText);
}

function renderPlotlyChart(chartData, player, date) {
  // 使用 Plotly.js 對分析後的數據點進行渲染，包含 Tooltips 進階顯示
  const lang = translations[currentLang];
  const hoverTemplate = 
    `<b>Player ID:</b> %{customdata[6]}<br>` +
    `<b>${lang.tooltipSeq}:</b> #%{x}<br>` +
    `<b>${lang.tooltipTime}:</b> %{customdata[4]}<br>` +
    `<b>${lang.thBetType}:</b> %{customdata[5]}<br>` +
    `<b>${lang.tooltipSlot}:</b> %{customdata[3]}<br>` +
    `<b>${lang.tooltipCumProfit}:</b> %{y:,.0f} IDR<br>` +
    `<b>${lang.tooltipNetProfit}:</b> %{customdata[0]}<br>` +
    `<b>${lang.tooltipBet}:</b> %{customdata[1]} | <b>${lang.tooltipPrize}:</b> %{customdata[2]}<br>` +
    "<extra></extra>";

  // 1. 依 bet_type 將累計利潤曲線分段上色
  const betTypeSegments = new Map();
  chartData.forEach((row, idx) => {
    const betTypeKey = getBetTypeKey(row.bet_type);
    if (!betTypeSegments.has(betTypeKey)) {
      betTypeSegments.set(betTypeKey, {
        betType: row.bet_type,
        x: [],
        y: [],
        customdata: []
      });
    }

    const segment = betTypeSegments.get(betTypeKey);
    if (idx === 0) {
      segment.x.push(row.play_seq);
      segment.y.push(row.daily_cum_profit);
      segment.customdata.push(buildChartCustomData(row, lang));
      return;
    }

    const prevRow = chartData[idx - 1];
    segment.x.push(prevRow.play_seq, row.play_seq, null);
    segment.y.push(prevRow.daily_cum_profit, row.daily_cum_profit, null);
    segment.customdata.push(buildChartCustomData(prevRow, lang), buildChartCustomData(row, lang), null);
  });

  const profitTraces = Array.from(betTypeSegments.values()).map(segment => ({
    x: segment.x,
    y: segment.y,
    customdata: segment.customdata,
    mode: 'lines+markers',
    name: `${lang.chartLegendProfit} - ${getBetTypeLabel(segment.betType, lang)}`,
    line: {
      color: getBetTypeColor(segment.betType),
      width: 3.5,
      shape: 'linear'
    },
    marker: {
      size: 5,
      color: getBetTypeColor(segment.betType)
    },
    hovertemplate: hoverTemplate,
    type: 'scatter'
  }));

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

  const dataTraces = [...profitTraces];
  if (fgDataset.length > 0) dataTraces.push(freeGameTrace);
  if (gsDataset.length > 0) dataTraces.push(gameSwitchTrace);

  Plotly.newPlot('chart-viewport', dataTraces, layout, config);
}

function resetDashboardState() {
  // 重置清空目前指標數據看板、表格與圖表至初始狀態
  analyzedData = [];
  
  metricStatsSpins.textContent = "0";
  metricStatsTotalWager.textContent = "0 IDR";
  metricStatsTotalPayout.textContent = "0 IDR";
  metricStatsNetProfit.textContent = "0 IDR";
  metricStatsNetProfit.className = 'metric-value';
  metricStatsFirstSpin.textContent = "--";
  metricStatsLastUpdate.textContent = "--";
  metricTotalSpins.textContent = "0";
  metricTotalWager.textContent = "0 IDR";
  metricTotalPayout.textContent = "0 IDR";
  metricNetProfit.textContent = "0 IDR";
  metricNetProfit.className = 'metric-value';
  metricGameSwitches.textContent = "0";
  metricFreeGames.textContent = "0";
  
  tableBody.innerHTML = `
    <tr>
      <td id="td-empty" colspan="11" style="text-align: center; color: var(--text-secondary); padding: 2rem;">
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

function getMinSpinsValue() {
  const parsedValue = parseInt(minSpinsInput.value, 10);
  return Number.isInteger(parsedValue) && parsedValue >= 0 ? parsedValue : 0;
}

function getMaxSpinsValue() {
  const minSpins = getMinSpinsValue();
  const parsedValue = parseInt(maxSpinsInput.value, 10);
  const maxSpins = Number.isInteger(parsedValue) && parsedValue >= 0 ? parsedValue : 10000;
  return Math.max(maxSpins, minSpins);
}

function normalizeSpinRangeInputs() {
  minSpinsInput.value = getMinSpinsValue();
  maxSpinsInput.value = getMaxSpinsValue();
}

function parseNullableNumber(value) {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatCount(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "--";
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Number(value));
}

function formatNullableCurrency(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "--";
  return formatCurrency(Number(value));
}

function getProfitClass(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '';
  return Number(value) >= 0 ? 'profit-positive' : 'profit-negative';
}

function formatDateTimeText(value) {
  if (!value) return "--";
  return value;
}

function getBetTypeKey(betType) {
  return betType === null || betType === undefined ? 'unknown' : String(betType);
}

function getBetTypeLabel(betType, lang) {
  if (betType === undefined || betType === null) return '--';
  const bType = Number(betType);
  if (bType === 1) return lang.betTypeNormal;
  if (bType === 2) return lang.betTypeAnte;
  if (bType === 3) return lang.betTypeBuy;
  return lang.betTypeUnknown.replace('{type}', bType);
}

function getBetTypeColor(betType) {
  const bType = Number(betType);
  if (bType === 1) return '#6366f1';
  if (bType === 2) return '#f59e0b';
  if (bType === 3) return '#10b981';
  return '#94a3b8';
}

function buildChartCustomData(row, lang) {
  return [
    formatCurrency(row.net_profit),
    formatCurrency(row.bet_amount),
    formatCurrency(row.total_prize),
    row.slot_id,
    formatDateTimeForTooltip(row.bet_at),
    getBetTypeLabel(row.bet_type, lang),
    row.player_id
  ];
}

function formatDateTimeForTooltip(dateValue) {
  if (!(dateValue instanceof Date) || Number.isNaN(dateValue.getTime())) return '--';
  const datePart = dateValue.toLocaleDateString('en-CA');
  const timePart = dateValue.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return `${datePart} ${timePart}`;
}

function addOneCalendarMonth(date) {
  const next = new Date(date.getTime());
  const originalDay = next.getDate();
  next.setDate(1);
  next.setMonth(next.getMonth() + 1);
  const daysInTargetMonth = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
  next.setDate(Math.min(originalDay, daysInTargetMonth));
  return next;
}

function isDateRangeOverOneMonth(startDate, endDate) {
  const start = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);
  return end > addOneCalendarMonth(start);
}

function getDefaultRangeStartDate(dates, endDate) {
  const end = new Date(`${endDate}T00:00:00`);
  const minStart = new Date(end.getTime());
  const originalDay = minStart.getDate();
  minStart.setDate(1);
  minStart.setMonth(minStart.getMonth() - 1);
  const daysInTargetMonth = new Date(minStart.getFullYear(), minStart.getMonth() + 1, 0).getDate();
  minStart.setDate(Math.min(originalDay, daysInTargetMonth));

  const candidates = dates.filter(d => new Date(`${d}T00:00:00`) >= minStart && d <= endDate);
  return candidates.length ? candidates[candidates.length - 1] : endDate;
}

// 網頁加載完成後自動運行初始化
window.addEventListener('DOMContentLoaded', () => {
  updateLanguageUI();
  loadAvailableDates();
});
