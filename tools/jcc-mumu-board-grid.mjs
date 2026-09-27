const CALIBRATION = {
  schema: "jcc-mumu-board-grid-calibration-v1",
  source: "mumu_gi_4353_xy_visual_calibration",
  calibrated_at: "2026-07-01",
  rows: 4,
  columns: 7,
  row_order: "top_to_bottom",
  column_order: "left_to_right",
  evidence: {
    frame: ".omx/runtime-evidence/xy-grid-calibration-current/frame.png",
    state: ".omx/runtime-evidence/xy-grid-calibration-current/watch-live/state.json",
    note: "6-1 replay board with user-provided row/column ground truth.",
  },
  board_y_centers: {
    "1": 580,
    "2": 518,
    "3": 456,
    "4": 394,
  },
  board_x_centers_by_row: {
    "1": [566, 646, 726, 806, 886, 967, 1047],
    "2": [573, 657, 742, 826, 910, 994, 1079],
    "3": [580, 669, 757, 845, 934, 1022, 1111],
    "4": [588, 680, 773, 865, 958, 1050, 1143],
  },
  tolerances_px: {
    row: 38,
    column: 52,
  },
  legacy_logical_grid: {
    enabled: true,
    reason: "Older fixtures use logical board coordinates x=1..7,y=1..4; keep them explicit instead of mistaking them for screen pixels.",
  },
};

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nearestEntry(entries, value) {
  let best = null;
  for (const entry of entries) {
    const error = Math.abs(value - entry.value);
    if (!best || error < best.error) best = { ...entry, error };
  }
  return best;
}

function confidenceFromErrors(rowError, columnError) {
  const rowScore = 1 - Math.min(rowError / CALIBRATION.tolerances_px.row, 1);
  const columnScore = 1 - Math.min(columnError / CALIBRATION.tolerances_px.column, 1);
  return Number(Math.max(0, Math.min(0.99, 0.55 + (rowScore + columnScore) * 0.22)).toFixed(3));
}

function positionWords(row, column) {
  return {
    row: `第${row}行`,
    from_left: `左${column}`,
    from_right: `右${CALIBRATION.columns + 1 - column}`,
    compact: `第${row}行 左${column}/右${CALIBRATION.columns + 1 - column}`,
  };
}

function logicalGridFromXY(x, y) {
  if (!CALIBRATION.legacy_logical_grid.enabled) return null;
  if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
  if (x < 1 || x > CALIBRATION.columns || y < 1 || y > CALIBRATION.rows) return null;
  return {
    source: "mumu_gi_logical_grid_legacy",
    row: y,
    row_from_top: y,
    col: x,
    col_from_left: x,
    col_from_right: CALIBRATION.columns + 1 - x,
    rows: CALIBRATION.rows,
    columns: CALIBRATION.columns,
    confidence: 0.85,
    error_px: null,
    position_words: positionWords(y, x),
  };
}

export function mapMumuGiXYToBoardGrid(inputX, inputY) {
  const x = numberOrNull(inputX);
  const y = numberOrNull(inputY);
  if (x == null || y == null) return null;

  const legacy = logicalGridFromXY(x, y);
  if (legacy) return legacy;

  const rows = Object.entries(CALIBRATION.board_y_centers).map(([row, value]) => ({
    row: Number(row),
    value,
  }));
  const nearestRow = nearestEntry(rows, y);
  if (!nearestRow || nearestRow.error > CALIBRATION.tolerances_px.row) return null;

  const rowCenters = CALIBRATION.board_x_centers_by_row[String(nearestRow.row)] || [];
  const columns = rowCenters.map((value, index) => ({ column: index + 1, value }));
  const nearestColumn = nearestEntry(columns, x);
  if (!nearestColumn || nearestColumn.error > CALIBRATION.tolerances_px.column) return null;

  return {
    source: "mumu_gi_xy_calibrated_board_grid",
    row: nearestRow.row,
    row_from_top: nearestRow.row,
    col: nearestColumn.column,
    col_from_left: nearestColumn.column,
    col_from_right: CALIBRATION.columns + 1 - nearestColumn.column,
    rows: CALIBRATION.rows,
    columns: CALIBRATION.columns,
    confidence: confidenceFromErrors(nearestRow.error, nearestColumn.error),
    error_px: {
      row: Number(nearestRow.error.toFixed(2)),
      column: Number(nearestColumn.error.toFixed(2)),
    },
    calibrated_center: {
      x: nearestColumn.value,
      y: nearestRow.value,
    },
    position_words: positionWords(nearestRow.row, nearestColumn.column),
  };
}

export function attachMumuBoardGrid(unit) {
  const x = unit?.position?.x ?? unit?.x;
  const y = unit?.position?.y ?? unit?.y;
  const boardGrid = mapMumuGiXYToBoardGrid(x, y);
  return {
    ...unit,
    position: {
      ...(unit?.position || {}),
      board_grid: boardGrid,
      board_grid_status: boardGrid ? "mapped" : "outside_calibrated_board_grid",
      board_grid_calibration: CALIBRATION.schema,
    },
  };
}

export function hasMumuBoardGrid(unit) {
  return !!unit?.position?.board_grid;
}

export function isMumuGiXYOnCalibratedBoard(unit) {
  const x = unit?.position?.x ?? unit?.x;
  const y = unit?.position?.y ?? unit?.y;
  return !!mapMumuGiXYToBoardGrid(x, y);
}

export function mirrorBoardGridForOpponent(boardGrid) {
  if (!boardGrid) return null;
  const row = CALIBRATION.rows + 1 - Number(boardGrid.row);
  const column = CALIBRATION.columns + 1 - Number(boardGrid.col);
  return {
    ...boardGrid,
    source: `${boardGrid.source}_opponent_mirror`,
    row,
    row_from_top: row,
    col: column,
    col_from_left: column,
    col_from_right: CALIBRATION.columns + 1 - column,
    position_words: positionWords(row, column),
  };
}

export function getMumuBoardGridCalibration() {
  return structuredClone(CALIBRATION);
}
