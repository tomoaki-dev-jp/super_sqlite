(function () {
  const vscode = acquireVsCodeApi();

  const state = {
    tables: [],
    current: null, // テーブル名
    page: 0,
    pageSize: 200,
    total: 0,
    columns: [],
    rows: [],
    rowIds: [],
    hasRowId: false,
    pkColumns: [],
    columnMeta: [],
    schema: {}, // テーブル名 -> 列名一覧（自動補完用）
    filters: {}, // 列名 -> { op, value }（Excel 風フィルタ）
    sort: null // { column, dir }
  };

  // フィルタ再読込後に検索行の入力フォーカス/キャレットを復元するための情報
  let pendingFocus = null;

  // ---- DOM ----
  const $ = (id) => document.getElementById(id);
  const tableSelect = $("tableSelect");
  const grid = $("grid");
  const pageInfo = $("pageInfo");
  const statusEl = $("status");

  // ---- タブ切替 ----
  function switchTab(tab) {
    document.querySelectorAll(".tab").forEach((b) => {
      b.classList.toggle("active", b.dataset.tab === tab);
    });
    $("dataView").classList.toggle("hidden", tab !== "data");
    $("queryView").classList.toggle("hidden", tab !== "query");
  }
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  // ---- ツールバー ----
  tableSelect.addEventListener("change", () => {
    state.current = tableSelect.value;
    state.page = 0;
    state.filters = {}; // テーブルを変えたらフィルタ・並べ替えはリセット
    state.sort = null;
    loadTable();
  });
  $("addRowBtn").addEventListener("click", addRow);
  $("refreshBtn").addEventListener("click", () => vscode.postMessage({ type: "refresh" }));
  $("prevPage").addEventListener("click", () => {
    if (state.page > 0) {
      state.page--;
      loadTable();
    }
  });
  $("nextPage").addEventListener("click", () => {
    if ((state.page + 1) * state.pageSize < state.total) {
      state.page++;
      loadTable();
    }
  });

  // ---- SQL エディタ ----
  const sqlEditor = $("sqlEditor");
  $("runBtn").addEventListener("click", runQuery);
  sqlEditor.addEventListener("keydown", (e) => {
    // 補完候補が開いていればキー操作を補完側で処理
    if (ac.open && handleAcKeydown(e)) {
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      runQuery();
    }
  });
  sqlEditor.addEventListener("input", () => updateAutocomplete());
  sqlEditor.addEventListener("blur", () => setTimeout(closeAutocomplete, 120));
  sqlEditor.addEventListener("scroll", closeAutocomplete);

  // ---- SQL 自動補完 ----
  const SQL_KEYWORDS = [
    "SELECT", "FROM", "WHERE", "INSERT", "INTO", "VALUES", "UPDATE", "SET",
    "DELETE", "CREATE", "TABLE", "DROP", "ALTER", "ADD", "COLUMN", "INDEX",
    "VIEW", "TRIGGER", "JOIN", "INNER", "LEFT", "RIGHT", "OUTER", "CROSS",
    "ON", "USING", "AS", "GROUP", "BY", "ORDER", "HAVING", "LIMIT", "OFFSET",
    "DISTINCT", "ALL", "AND", "OR", "NOT", "NULL", "IS", "IN", "LIKE", "GLOB",
    "BETWEEN", "EXISTS", "CASE", "WHEN", "THEN", "ELSE", "END", "UNION",
    "INTERSECT", "EXCEPT", "ASC", "DESC", "PRIMARY", "KEY", "FOREIGN",
    "REFERENCES", "UNIQUE", "CHECK", "DEFAULT", "AUTOINCREMENT", "INTEGER",
    "TEXT", "REAL", "BLOB", "NUMERIC", "COUNT", "SUM", "AVG", "MIN", "MAX",
    "TOTAL", "ABS", "ROUND", "LENGTH", "LOWER", "UPPER", "SUBSTR", "REPLACE",
    "COALESCE", "IFNULL", "DATE", "TIME", "DATETIME", "STRFTIME", "PRAGMA",
    "VACUUM", "REINDEX", "EXPLAIN", "BEGIN", "COMMIT", "ROLLBACK", "TRANSACTION"
  ];

  const acBox = document.createElement("div");
  acBox.id = "autocomplete";
  acBox.className = "autocomplete hidden";
  document.body.appendChild(acBox);

  const ac = { open: false, items: [], index: 0, start: 0, end: 0 };

  // カーソル直前のトークン（および table. 形式）を解析
  function acContext() {
    const pos = sqlEditor.selectionStart;
    if (pos !== sqlEditor.selectionEnd) {
      return null; // 範囲選択中は補完しない
    }
    const before = sqlEditor.value.slice(0, pos);
    const dotted = /([A-Za-z_]\w*)\.(\w*)$/.exec(before);
    if (dotted) {
      return { kind: "dotted", table: dotted[1], prefix: dotted[2], start: pos - dotted[2].length, end: pos };
    }
    const word = /(\w*)$/.exec(before)[1];
    return { kind: "word", prefix: word, start: pos - word.length, end: pos };
  }

  function lookupColumns(tableName) {
    const key = Object.keys(state.schema).find(
      (k) => k.toLowerCase() === tableName.toLowerCase()
    );
    return key ? state.schema[key] : [];
  }

  function buildCandidates(ctx) {
    if (ctx.kind === "dotted") {
      return lookupColumns(ctx.table).map((c) => ({ label: c, type: "列" }));
    }
    const list = [];
    state.tables.forEach((t) => list.push({ label: t.name, type: t.type === "view" ? "ビュー" : "表" }));
    const seen = new Set();
    Object.values(state.schema).forEach((cols) =>
      cols.forEach((c) => {
        const lc = c.toLowerCase();
        if (!seen.has(lc)) {
          seen.add(lc);
          list.push({ label: c, type: "列" });
        }
      })
    );
    SQL_KEYWORDS.forEach((k) => list.push({ label: k, type: "句" }));
    return list;
  }

  function updateAutocomplete() {
    const ctx = acContext();
    if (!ctx) {
      return closeAutocomplete();
    }
    // 通常トークンは 1 文字以上、table. の後は空でも候補を出す
    if (ctx.kind === "word" && ctx.prefix.length < 1) {
      return closeAutocomplete();
    }
    const pfx = ctx.prefix.toLowerCase();
    let items = buildCandidates(ctx).filter((c) => c.label.toLowerCase().startsWith(pfx));
    // 完全一致のみ（自分自身）なら出さない
    if (items.length === 0 || (items.length === 1 && items[0].label.toLowerCase() === pfx)) {
      return closeAutocomplete();
    }
    items = items.slice(0, 50);
    ac.items = items;
    ac.index = 0;
    ac.start = ctx.start;
    ac.end = ctx.end;
    renderAutocomplete();
  }

  function renderAutocomplete() {
    acBox.innerHTML = "";
    ac.items.forEach((it, i) => {
      const row = document.createElement("div");
      row.className = "ac-item" + (i === ac.index ? " active" : "");
      const label = document.createElement("span");
      label.className = "ac-label";
      label.textContent = it.label;
      const type = document.createElement("span");
      type.className = "ac-type";
      type.textContent = it.type;
      row.appendChild(label);
      row.appendChild(type);
      row.addEventListener("mousedown", (e) => {
        e.preventDefault(); // blur を防ぐ
        applyAutocomplete(i);
      });
      acBox.appendChild(row);
    });
    const caret = caretCoords();
    acBox.style.left = caret.left + "px";
    acBox.style.top = caret.top + "px";
    acBox.classList.remove("hidden");
    ac.open = true;
    scrollActiveIntoView();
  }

  function closeAutocomplete() {
    if (!ac.open) {
      return;
    }
    ac.open = false;
    acBox.classList.add("hidden");
  }

  function moveAc(delta) {
    ac.index = (ac.index + delta + ac.items.length) % ac.items.length;
    renderAutocomplete();
  }

  function scrollActiveIntoView() {
    const active = acBox.querySelector(".ac-item.active");
    if (active) {
      active.scrollIntoView({ block: "nearest" });
    }
  }

  function applyAutocomplete(i) {
    const item = ac.items[i];
    if (!item) {
      return;
    }
    const v = sqlEditor.value;
    sqlEditor.value = v.slice(0, ac.start) + item.label + v.slice(ac.end);
    const newPos = ac.start + item.label.length;
    sqlEditor.setSelectionRange(newPos, newPos);
    closeAutocomplete();
    sqlEditor.focus();
  }

  // 補完が開いているときのキー操作。処理したら true を返す
  function handleAcKeydown(e) {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        moveAc(1);
        return true;
      case "ArrowUp":
        e.preventDefault();
        moveAc(-1);
        return true;
      case "Enter":
      case "Tab":
        e.preventDefault();
        applyAutocomplete(ac.index);
        return true;
      case "Escape":
        e.preventDefault();
        closeAutocomplete();
        return true;
      default:
        return false;
    }
  }

  // textarea 内のカーソル位置のピクセル座標を求める（ミラー要素方式）
  function caretCoords() {
    const rect = sqlEditor.getBoundingClientRect();
    const style = getComputedStyle(sqlEditor);
    const mirror = document.createElement("div");
    const props = [
      "boxSizing", "width", "paddingTop", "paddingRight", "paddingBottom",
      "paddingLeft", "borderTopWidth", "borderRightWidth", "borderBottomWidth",
      "borderLeftWidth", "fontFamily", "fontSize", "fontWeight", "fontStyle",
      "letterSpacing", "lineHeight", "textTransform", "wordSpacing", "tabSize"
    ];
    props.forEach((p) => (mirror.style[p] = style[p]));
    mirror.style.position = "absolute";
    mirror.style.visibility = "hidden";
    mirror.style.whiteSpace = "pre-wrap";
    mirror.style.wordWrap = "break-word";
    mirror.style.overflow = "hidden";
    mirror.style.top = "0";
    mirror.style.left = "-9999px";
    const pos = sqlEditor.selectionStart;
    mirror.textContent = sqlEditor.value.slice(0, pos);
    const marker = document.createElement("span");
    marker.textContent = "​";
    mirror.appendChild(marker);
    document.body.appendChild(mirror);
    const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.4;
    const left = rect.left + window.scrollX + marker.offsetLeft - sqlEditor.scrollLeft;
    const top = rect.top + window.scrollY + marker.offsetTop - sqlEditor.scrollTop + lineHeight;
    document.body.removeChild(mirror);
    return { left, top };
  }

  function runQuery() {
    const sql = getSelectedSql();
    if (!sql.trim()) {
      return;
    }
    $("queryStatus").textContent = "実行中...";
    vscode.postMessage({ type: "runQuery", sql });
  }

  // 選択範囲があればそれを、無ければ全体を実行
  function getSelectedSql() {
    const s = sqlEditor.selectionStart;
    const e = sqlEditor.selectionEnd;
    if (s !== e) {
      return sqlEditor.value.substring(s, e);
    }
    return sqlEditor.value;
  }

  function loadTable() {
    if (!state.current) {
      return;
    }
    vscode.postMessage({
      type: "loadTable",
      table: state.current,
      page: state.page,
      filters: activeFilterList(),
      sort: state.sort
    });
  }

  // 値が必要な演算子で値が空のものは除外して、サーバ送信用の配列に変換
  const VALUE_OPS = new Set([
    "contains", "notContains", "startsWith", "endsWith",
    "equals", "notEquals", "gt", "ge", "lt", "le"
  ]);
  function activeFilterList() {
    const out = [];
    for (const [column, f] of Object.entries(state.filters)) {
      if (!f || !f.op) {
        continue;
      }
      if (VALUE_OPS.has(f.op) && (f.value === "" || f.value == null)) {
        continue;
      }
      out.push({ column, op: f.op, value: f.value });
    }
    return out;
  }

  // フィルタ適用 → 1 ページ目から再読込
  function applyFilters() {
    state.page = 0;
    loadTable();
  }

  // ---- データグリッド描画 ----
  function renderGrid() {
    if (!state.current) {
      grid.innerHTML = '<div class="empty">テーブルを選択してください。</div>';
      pageInfo.textContent = "";
      return;
    }
    const pkSet = new Set(state.pkColumns);
    const table = document.createElement("table");
    table.className = "data";

    // ヘッダ（列名 + 並べ替えインジケータ + ▼メニュー）
    const thead = document.createElement("thead");
    const htr = document.createElement("tr");
    htr.appendChild(th("")); // 行アクション列
    state.columns.forEach((c) => {
      const cell = document.createElement("th");
      if (pkSet.has(c)) {
        cell.classList.add("pk");
      }
      const head = document.createElement("div");
      head.className = "th-head";

      const label = document.createElement("span");
      label.className = "th-label";
      label.textContent = c;
      label.title = "クリックで並べ替え";
      label.addEventListener("click", () => cycleSort(c));

      const indicator = document.createElement("span");
      indicator.className = "th-sort";
      if (state.sort && state.sort.column === c) {
        indicator.textContent = state.sort.dir === "asc" ? "▲" : "▼";
      }

      const menuBtn = document.createElement("button");
      menuBtn.className = "th-menu";
      menuBtn.textContent = "▾";
      menuBtn.title = "フィルタ / 並べ替え";
      if (state.filters[c]) {
        menuBtn.classList.add("filtered");
      }
      menuBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        openHeaderMenu(c, menuBtn);
      });

      head.appendChild(label);
      head.appendChild(indicator);
      head.appendChild(menuBtn);
      cell.appendChild(head);
      htr.appendChild(cell);
    });
    thead.appendChild(htr);

    // 検索行（即フィルタ）
    const ftr = document.createElement("tr");
    ftr.className = "filter-row";
    ftr.appendChild(th("")); // 行アクション列
    state.columns.forEach((c) => {
      const fc = document.createElement("th");
      const input = document.createElement("input");
      input.className = "filter-input";
      input.type = "text";
      input.placeholder = "🔍";
      const f = state.filters[c];
      // 検索行は contains フィルタを表す。別演算子が設定済みなら表示だけ調整
      if (f && f.op === "contains") {
        input.value = f.value ?? "";
      } else if (f) {
        input.placeholder = opLabel(f.op) + (f.value != null && f.value !== "" ? " " + f.value : "");
        input.classList.add("has-cond");
      }
      input.dataset.col = c;
      input.addEventListener("input", () => onQuickFilter(c, input));
      fc.appendChild(input);
      ftr.appendChild(fc);
    });
    thead.appendChild(ftr);
    table.appendChild(thead);

    // ボディ
    const tbody = document.createElement("tbody");
    state.rows.forEach((row, rIdx) => {
      const tr = document.createElement("tr");

      const actions = document.createElement("td");
      actions.className = "rowActions";
      const del = document.createElement("button");
      del.className = "delBtn";
      del.textContent = "✕";
      del.title = "この行を削除";
      del.addEventListener("click", () => deleteRow(rIdx));
      actions.appendChild(del);
      tr.appendChild(actions);

      state.columns.forEach((col, cIdx) => {
        const td = document.createElement("td");
        td.className = "editable";
        setCellDisplay(td, row[cIdx]);
        td.addEventListener("dblclick", () => beginEdit(td, rIdx, cIdx, col));
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    grid.innerHTML = "";
    grid.appendChild(table);

    // 2 段ヘッダの sticky が重ならないよう、検索行を 1 段目の高さ分だけ下げる
    const headRow = table.querySelector("thead tr:first-child");
    if (headRow) {
      const h = headRow.offsetHeight;
      table.querySelectorAll(".filter-row th").forEach((el) => {
        el.style.top = h + "px";
      });
    }

    if (state.rows.length === 0) {
      const note = activeFilterList().length > 0
        ? "条件に一致する行がありません。"
        : "行がありません。「＋ 行」で追加できます。";
      grid.insertAdjacentHTML("beforeend", `<div class="empty">${note}</div>`);
    }

    const from = state.total === 0 ? 0 : state.page * state.pageSize + 1;
    const to = Math.min(state.total, (state.page + 1) * state.pageSize);
    const filtered = activeFilterList().length > 0;
    pageInfo.textContent =
      `${from}–${to} / ${state.total} 行` + (filtered ? "（フィルタ適用中）" : "");

    // 検索行入力中だったらフォーカス/キャレットを復元
    if (pendingFocus) {
      const sel = `.filter-input[data-col="${cssEscape(pendingFocus.col)}"]`;
      const input = grid.querySelector(sel);
      if (input) {
        input.focus();
        const pos = pendingFocus.caret != null ? pendingFocus.caret : input.value.length;
        try {
          input.setSelectionRange(pos, pos);
        } catch (_) {
          /* ignore */
        }
      }
      pendingFocus = null;
    }
  }

  function cssEscape(s) {
    return String(s).replace(/["\\]/g, "\\$&");
  }

  function th(text) {
    const el = document.createElement("th");
    el.textContent = text;
    return el;
  }

  // ---- フィルタ / 並べ替え ----
  const OP_LABELS = {
    contains: "含む",
    notContains: "含まない",
    startsWith: "で始まる",
    endsWith: "で終わる",
    equals: "等しい",
    notEquals: "等しくない",
    gt: "より大きい (>)",
    ge: "以上 (>=)",
    lt: "より小さい (<)",
    le: "以下 (<=)",
    empty: "空 (NULL/空文字)",
    notEmpty: "空でない"
  };
  function opLabel(op) {
    return OP_LABELS[op] || op;
  }

  let quickTimer = null;
  // 検索行への入力（デバウンスして contains フィルタを適用）
  function onQuickFilter(col, input) {
    const v = input.value;
    if (v === "") {
      delete state.filters[col];
    } else {
      state.filters[col] = { op: "contains", value: v };
    }
    pendingFocus = { col, caret: input.selectionStart };
    clearTimeout(quickTimer);
    quickTimer = setTimeout(applyFilters, 250);
  }

  // ヘッダのラベルクリックで 昇順→降順→解除 を循環
  function cycleSort(col) {
    if (!state.sort || state.sort.column !== col) {
      state.sort = { column: col, dir: "asc" };
    } else if (state.sort.dir === "asc") {
      state.sort = { column: col, dir: "desc" };
    } else {
      state.sort = null;
    }
    loadTable();
  }

  const menuBox = document.createElement("div");
  menuBox.id = "headerMenu";
  menuBox.className = "header-menu hidden";
  document.body.appendChild(menuBox);
  let menuCol = null;

  function closeHeaderMenu() {
    menuBox.classList.add("hidden");
    menuCol = null;
  }
  document.addEventListener("mousedown", (e) => {
    if (!menuBox.classList.contains("hidden") && !menuBox.contains(e.target)) {
      closeHeaderMenu();
    }
  });
  window.addEventListener("resize", closeHeaderMenu);

  function openHeaderMenu(col, anchor) {
    if (menuCol === col && !menuBox.classList.contains("hidden")) {
      return closeHeaderMenu();
    }
    menuCol = col;
    const current = state.filters[col] || { op: "contains", value: "" };
    menuBox.innerHTML = "";

    // 並べ替え
    const sortGroup = document.createElement("div");
    sortGroup.className = "hm-group";
    sortGroup.appendChild(menuItem("▲ 昇順で並べ替え", () => {
      state.sort = { column: col, dir: "asc" };
      closeHeaderMenu();
      loadTable();
    }));
    sortGroup.appendChild(menuItem("▼ 降順で並べ替え", () => {
      state.sort = { column: col, dir: "desc" };
      closeHeaderMenu();
      loadTable();
    }));
    if (state.sort && state.sort.column === col) {
      sortGroup.appendChild(menuItem("× 並べ替え解除", () => {
        state.sort = null;
        closeHeaderMenu();
        loadTable();
      }));
    }
    menuBox.appendChild(sortGroup);

    menuBox.appendChild(divider());

    // フィルタ
    const fGroup = document.createElement("div");
    fGroup.className = "hm-group";
    const title = document.createElement("div");
    title.className = "hm-title";
    title.textContent = "フィルタ条件";
    fGroup.appendChild(title);

    const opSel = document.createElement("select");
    opSel.className = "hm-op";
    Object.keys(OP_LABELS).forEach((op) => {
      const o = document.createElement("option");
      o.value = op;
      o.textContent = OP_LABELS[op];
      if (op === current.op) {
        o.selected = true;
      }
      opSel.appendChild(o);
    });
    fGroup.appendChild(opSel);

    const valInput = document.createElement("input");
    valInput.className = "hm-val";
    valInput.type = "text";
    valInput.placeholder = "値";
    valInput.value = current.value != null ? current.value : "";
    fGroup.appendChild(valInput);

    const syncValDisabled = () => {
      const noVal = opSel.value === "empty" || opSel.value === "notEmpty";
      valInput.style.display = noVal ? "none" : "";
    };
    syncValDisabled();
    opSel.addEventListener("change", syncValDisabled);

    const apply = () => {
      const op = opSel.value;
      const needVal = op !== "empty" && op !== "notEmpty";
      if (needVal && valInput.value === "") {
        delete state.filters[col];
      } else {
        state.filters[col] = { op, value: needVal ? valInput.value : undefined };
      }
      closeHeaderMenu();
      applyFilters();
    };
    valInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        apply();
      }
    });

    const actions = document.createElement("div");
    actions.className = "hm-actions";
    const applyBtn = document.createElement("button");
    applyBtn.textContent = "適用";
    applyBtn.addEventListener("click", apply);
    const clearBtn = document.createElement("button");
    clearBtn.textContent = "クリア";
    clearBtn.addEventListener("click", () => {
      delete state.filters[col];
      closeHeaderMenu();
      applyFilters();
    });
    actions.appendChild(applyBtn);
    actions.appendChild(clearBtn);
    fGroup.appendChild(actions);
    menuBox.appendChild(fGroup);

    // 位置決め（ボタン直下、右端からはみ出さないよう調整）
    menuBox.classList.remove("hidden");
    const r = anchor.getBoundingClientRect();
    const mw = menuBox.offsetWidth;
    let left = r.left + window.scrollX;
    const maxLeft = window.scrollX + document.documentElement.clientWidth - mw - 8;
    if (left > maxLeft) {
      left = Math.max(8, maxLeft);
    }
    menuBox.style.left = left + "px";
    menuBox.style.top = r.bottom + window.scrollY + 2 + "px";
    setTimeout(() => valInput.focus(), 0);
  }

  function menuItem(text, onClick) {
    const el = document.createElement("div");
    el.className = "hm-item";
    el.textContent = text;
    el.addEventListener("click", onClick);
    return el;
  }
  function divider() {
    const d = document.createElement("div");
    d.className = "hm-divider";
    return d;
  }

  function setCellDisplay(td, value) {
    td.classList.remove("null");
    if (value === null || value === undefined) {
      td.textContent = "NULL";
      td.classList.add("null");
    } else if (value instanceof Uint8Array) {
      td.textContent = `[BLOB ${value.length} bytes]`;
      td.classList.add("null");
    } else {
      td.textContent = String(value);
    }
  }

  // ---- インライン編集 ----
  function beginEdit(td, rIdx, cIdx, col) {
    const current = state.rows[rIdx][cIdx];
    const input = document.createElement("input");
    input.className = "cellInput";
    input.value = current === null || current === undefined ? "" : String(current);
    td.textContent = "";
    td.appendChild(input);
    input.focus();
    input.select();

    let done = false;
    const commit = (save) => {
      if (done) {
        return;
      }
      done = true;
      if (!save) {
        setCellDisplay(td, state.rows[rIdx][cIdx]);
        return;
      }
      const raw = input.value;
      // 空入力かつ元が NULL なら NULL 維持。空 -> NULL にしたい場合の簡易ルール。
      const makeNull = raw === "" && (current === null || current === undefined);
      saveCell(rIdx, cIdx, col, raw, makeNull, td);
    };

    input.addEventListener("blur", () => commit(true));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        input.blur();
      } else if (e.key === "Escape") {
        e.preventDefault();
        commit(false);
      }
    });
  }

  function saveCell(rIdx, cIdx, col, value, isNull, td) {
    const msg = {
      type: "updateCell",
      table: state.current,
      column: col,
      value: isNull ? null : value,
      isNull,
      hasRowId: state.hasRowId,
      rowid: state.hasRowId ? state.rowIds[rIdx] : undefined,
      keys: buildKeys(rIdx),
      page: state.page
    };
    // 楽観的に表示更新
    state.rows[rIdx][cIdx] = isNull ? null : value;
    setCellDisplay(td, state.rows[rIdx][cIdx]);
    vscode.postMessage(msg);
  }

  // rowid が無いテーブル用に PK 列で WHERE を作る
  function buildKeys(rIdx) {
    if (state.hasRowId) {
      return [];
    }
    return state.pkColumns.map((pk) => {
      const idx = state.columns.indexOf(pk);
      return { column: pk, value: idx >= 0 ? state.rows[rIdx][idx] : null };
    });
  }

  function deleteRow(rIdx) {
    vscode.postMessage({
      type: "deleteRow",
      table: state.current,
      hasRowId: state.hasRowId,
      rowid: state.hasRowId ? state.rowIds[rIdx] : undefined,
      keys: buildKeys(rIdx),
      page: state.page
    });
  }

  function addRow() {
    if (!state.current) {
      return;
    }
    // 全列デフォルト値で 1 行追加（後からセル編集）
    vscode.postMessage({ type: "insertRow", table: state.current, values: {}, page: state.page });
  }

  // ---- クエリ結果描画 ----
  function renderQueryResult(msg) {
    const box = $("queryResult");
    if (!msg.hasResultSet) {
      box.innerHTML = `<div class="msg-ok">OK — ${msg.rowsModified} 行が変更されました (${msg.elapsed}ms)</div>`;
      $("queryStatus").textContent = "";
      return;
    }
    const table = document.createElement("table");
    table.className = "data";
    const thead = document.createElement("thead");
    const htr = document.createElement("tr");
    msg.columns.forEach((c) => htr.appendChild(th(c)));
    thead.appendChild(htr);
    table.appendChild(thead);
    const tbody = document.createElement("tbody");
    msg.rows.forEach((row) => {
      const tr = document.createElement("tr");
      row.forEach((v) => {
        const td = document.createElement("td");
        setCellDisplay(td, v);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    box.innerHTML = "";
    box.appendChild(table);
    $("queryStatus").textContent = `${msg.rows.length} 行 (${msg.elapsed}ms)`;
  }

  // ---- メッセージ受信 ----
  window.addEventListener("message", (event) => {
    const msg = event.data;
    switch (msg.type) {
      case "init":
        state.tables = msg.tables;
        state.schema = msg.schema || {};
        tableSelect.innerHTML = "";
        msg.tables.forEach((t) => {
          const opt = document.createElement("option");
          opt.value = t.name;
          opt.textContent = t.type === "view" ? `${t.name} (view)` : t.name;
          tableSelect.appendChild(opt);
        });
        statusEl.textContent = msg.dbName;
        if (msg.initialTable && msg.tables.some((t) => t.name === msg.initialTable)) {
          tableSelect.value = msg.initialTable;
        }
        state.current = tableSelect.value || null;
        state.page = 0;
        state.filters = {};
        state.sort = null;
        loadTable();
        break;

      case "openTable":
        if (state.tables.some((t) => t.name === msg.table)) {
          tableSelect.value = msg.table;
          state.current = msg.table;
          state.page = 0;
          state.filters = {};
          state.sort = null;
          loadTable();
        }
        break;

      case "tableData":
        state.current = msg.table;
        state.columns = msg.columns;
        state.rows = msg.rows;
        state.rowIds = msg.rowIds;
        state.hasRowId = msg.hasRowId;
        state.pkColumns = msg.pkColumns || [];
        state.columnMeta = msg.columnMeta || [];
        state.page = msg.page;
        state.pageSize = msg.pageSize;
        state.total = msg.total;
        renderGrid();
        break;

      case "runExternalSql":
        // 外部の .sql / .spl ファイルから渡された SQL を SQL タブに流して実行
        switchTab("query");
        sqlEditor.value = msg.sql || "";
        sqlEditor.setSelectionRange(0, 0);
        runQuery();
        break;

      case "queryResult":
        renderQueryResult(msg);
        break;

      case "cellSaved":
        statusEl.textContent = "保存しました ✓";
        setTimeout(() => (statusEl.textContent = state.tables.length ? "" : ""), 1200);
        break;

      case "error":
        $("queryStatus").textContent = "";
        $("queryResult").innerHTML = `<div class="msg-error">${escapeHtml(msg.message)}</div>`;
        break;
    }
  });

  function escapeHtml(s) {
    return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  }

  // 起動通知
  vscode.postMessage({ type: "ready" });
})();
