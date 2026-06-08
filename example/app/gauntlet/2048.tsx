// 2048 — a real, swipe-driven board. Doubles as an MCP demo target: an
// agent reads the whole board from the `board-state` element (its
// accessibility label is the serialized grid + score + max tile + move
// count), decides a direction, and drives it with a swipe — the move goes
// through Ennio's HID path. Each tile also carries a `cell-<r>-<c>` testID
// so the board is legible from a screenshot or the element inventory.

import { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';
import { PressableScale } from 'pressto';

type Grid = number[][];
type Direction = 'LEFT' | 'RIGHT' | 'UP' | 'DOWN';

const SIZE = 4;

function emptyGrid(): Grid {
  return Array.from({ length: SIZE }, () => Array<number>(SIZE).fill(0));
}

function emptyCells(grid: Grid): [number, number][] {
  const cells: [number, number][] = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) if (grid[r][c] === 0) cells.push([r, c]);
  }
  return cells;
}

function spawn(grid: Grid): Grid {
  const cells = emptyCells(grid);
  if (cells.length === 0) return grid;
  const [r, c] = cells[Math.floor(Math.random() * cells.length)];
  const next = grid.map((row) => row.slice());
  next[r][c] = Math.random() < 0.9 ? 2 : 4;
  return next;
}

/** Slide + merge one row to the left. Returns the new row and points gained. */
function collapseRow(row: number[]): { row: number[]; gained: number } {
  const tiles = row.filter((v) => v !== 0);
  const merged: number[] = [];
  let gained = 0;
  for (let i = 0; i < tiles.length; i++) {
    if (i + 1 < tiles.length && tiles[i] === tiles[i + 1]) {
      const sum = tiles[i] * 2;
      merged.push(sum);
      gained += sum;
      i++; // consume the merged neighbour
    } else {
      merged.push(tiles[i]);
    }
  }
  while (merged.length < SIZE) merged.push(0);
  return { row: merged, gained };
}

function rotateForMove(grid: Grid, dir: Direction): Grid {
  // Normalise every direction to a LEFT collapse, then undo afterwards.
  switch (dir) {
    case 'LEFT':
      return grid.map((row) => row.slice());
    case 'RIGHT':
      return grid.map((row) => row.slice().reverse());
    case 'UP':
      return Array.from({ length: SIZE }, (_, c) => grid.map((row) => row[c]));
    case 'DOWN':
      return Array.from({ length: SIZE }, (_, c) => grid.map((row) => row[c]).reverse());
  }
}

function restoreFromMove(grid: Grid, dir: Direction): Grid {
  switch (dir) {
    case 'LEFT':
      return grid.map((row) => row.slice());
    case 'RIGHT':
      return grid.map((row) => row.slice().reverse());
    case 'UP':
      return Array.from({ length: SIZE }, (_, r) => grid.map((col) => col[r]));
    case 'DOWN':
      return Array.from({ length: SIZE }, (_, r) => grid.map((col) => col[SIZE - 1 - r]));
  }
}

function move(grid: Grid, dir: Direction): { grid: Grid; gained: number; moved: boolean } {
  const oriented = rotateForMove(grid, dir);
  let gained = 0;
  const collapsed = oriented.map((row) => {
    const res = collapseRow(row);
    gained += res.gained;
    return res.row;
  });
  const next = restoreFromMove(collapsed, dir);
  const moved = JSON.stringify(next) !== JSON.stringify(grid);
  return { grid: next, gained, moved };
}

function maxTile(grid: Grid): number {
  return Math.max(...grid.flat());
}

function canMove(grid: Grid): boolean {
  if (emptyCells(grid).length > 0) return true;
  return (['LEFT', 'UP'] as Direction[]).some((d) => move(grid, d).moved);
}

function freshGrid(): Grid {
  return spawn(spawn(emptyGrid()));
}

const TILE_COLORS: Record<number, string> = {
  0: '#cdc1b4',
  2: '#eee4da',
  4: '#ede0c8',
  8: '#f2b179',
  16: '#f59563',
  32: '#f67c5f',
  64: '#f65e3b',
  128: '#edcf72',
  256: '#edcc61',
  512: '#edc850',
  1024: '#edc53f',
  2048: '#edc22e',
};

export default function Game2048() {
  const [grid, setGrid] = useState<Grid>(freshGrid);
  const [score, setScore] = useState(0);
  const [moves, setMoves] = useState(0);

  const max = maxTile(grid);
  const status = max >= 2048 ? 'won' : canMove(grid) ? 'playing' : 'over';
  // The agent's single source of truth: one element whose accessibility
  // label is the entire game state. No screenshot parsing required.
  const stateLabel = JSON.stringify({ grid, score, max, moves, status });

  const applyMove = useCallback((dir: Direction) => {
    setGrid((current) => {
      const res = move(current, dir);
      if (!res.moved) return current;
      setScore((s) => s + res.gained);
      setMoves((m) => m + 1);
      return spawn(res.grid);
    });
  }, []);

  const reset = useCallback(() => {
    setGrid(freshGrid());
    setScore(0);
    setMoves(0);
  }, []);

  const pan = Gesture.Pan().onEnd((e) => {
    const { translationX: dx, translationY: dy } = e;
    if (Math.abs(dx) < 12 && Math.abs(dy) < 12) return;
    const dir: Direction =
      Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'RIGHT' : 'LEFT') : dy > 0 ? 'DOWN' : 'UP';
    runOnJS(applyMove)(dir);
  });

  return (
    <View style={styles.container} testID="game-2048-screen">
      <Text testID="board-state" accessibilityLabel={stateLabel} style={styles.state}>
        max {max} · moves {moves} · score {score} · {status}
      </Text>

      <GestureDetector gesture={pan}>
        <View style={styles.board} testID="board">
          {grid.map((row, r) => (
            <View key={r} style={styles.row}>
              {row.map((value, c) => (
                <View
                  key={c}
                  testID={`cell-${r}-${c}`}
                  style={[styles.cell, { backgroundColor: TILE_COLORS[value] ?? '#3c3a32' }]}
                >
                  {value > 0 && (
                    <Text style={[styles.cellText, value > 4 && styles.cellTextLight]}>
                      {value}
                    </Text>
                  )}
                </View>
              ))}
            </View>
          ))}
        </View>
      </GestureDetector>

      <PressableScale testID="reset-2048" style={styles.button} onPress={reset}>
        <Text style={styles.buttonText}>New game</Text>
      </PressableScale>
    </View>
  );
}

const GAP = 8;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#faf8ef',
  },
  state: { fontSize: 13, color: '#776e65', marginBottom: 16, fontVariant: ['tabular-nums'] },
  board: {
    backgroundColor: '#bbada0',
    padding: GAP,
    borderRadius: 8,
    borderCurve: 'continuous',
  },
  row: { flexDirection: 'row' },
  cell: {
    width: 70,
    height: 70,
    margin: GAP / 2,
    borderRadius: 6,
    borderCurve: 'continuous',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cellText: { fontSize: 28, fontWeight: '700', color: '#776e65' },
  cellTextLight: { color: '#f9f6f2' },
  button: {
    marginTop: 24,
    backgroundColor: '#8f7a66',
    paddingVertical: 12,
    paddingHorizontal: 28,
    borderRadius: 8,
    borderCurve: 'continuous',
  },
  buttonText: { color: '#f9f6f2', fontSize: 16, fontWeight: '600' },
});
