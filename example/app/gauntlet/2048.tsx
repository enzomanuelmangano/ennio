// 2048 — animated, swipe-driven board. Doubles as an MCP demo target.
//
// Tiles carry stable ids and slide to their new cell on every move
// (Reanimated), with a spawn scale-in and a merge pop — so the board has a
// real ~150ms post-move animation, not an instant snap. That animation is
// the point of the demo: a black-box driver must blind-wait for it to
// finish before reading, while an in-process driver (ennio) reads at the
// React commit and ignores the still-running animation.
//
// The whole game state is serialized into the `board-state` element's
// accessibility label (grid + score + max + moves + status), updated at
// commit — so an agent reads the board in one shot, mid-animation or not.

import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { PressableScale } from 'pressto';

type Direction = 'LEFT' | 'RIGHT' | 'UP' | 'DOWN';
interface Tile {
  id: number;
  value: number;
  r: number;
  c: number;
  merged?: boolean;
}

const SIZE = 4;
const CELL = 74; // tile + gap
const TILE = 66;
const SLIDE_MS = 150;

let nextId = 1;
const freshId = () => nextId++;

function emptyCells(tiles: Tile[]): [number, number][] {
  const taken = new Set(tiles.map((t) => `${t.r},${t.c}`));
  const cells: [number, number][] = [];
  for (let r = 0; r < SIZE; r++)
    for (let c = 0; c < SIZE; c++) if (!taken.has(`${r},${c}`)) cells.push([r, c]);
  return cells;
}

function spawn(tiles: Tile[]): Tile[] {
  const cells = emptyCells(tiles);
  if (!cells.length) return tiles;
  const [r, c] = cells[Math.floor(Math.random() * cells.length)];
  return [...tiles, { id: freshId(), value: Math.random() < 0.9 ? 2 : 4, r, c }];
}

function freshTiles(): Tile[] {
  return spawn(spawn([]));
}

// Direction-agnostic line/position transforms: every move is processed as
// a pack toward position 0 within each "line".
function lineOf(t: Tile, d: Direction): number {
  return d === 'LEFT' || d === 'RIGHT' ? t.r : t.c;
}
function posOf(t: Tile, d: Direction): number {
  return d === 'LEFT' ? t.c : d === 'RIGHT' ? SIZE - 1 - t.c : d === 'UP' ? t.r : SIZE - 1 - t.r;
}
function toRC(d: Direction, line: number, pos: number): { r: number; c: number } {
  if (d === 'LEFT') return { r: line, c: pos };
  if (d === 'RIGHT') return { r: line, c: SIZE - 1 - pos };
  if (d === 'UP') return { r: pos, c: line };
  return { r: SIZE - 1 - pos, c: line };
}

function move(tiles: Tile[], d: Direction): { tiles: Tile[]; gained: number; moved: boolean } {
  const lines = new Map<number, Tile[]>();
  for (const t of tiles) {
    const k = lineOf(t, d);
    (lines.get(k) ?? lines.set(k, []).get(k)!).push(t);
  }
  const out: Tile[] = [];
  let gained = 0;
  let moved = false;
  for (const [line, group] of lines) {
    group.sort((a, b) => posOf(a, d) - posOf(b, d));
    let target = 0;
    let prev: Tile | null = null;
    for (const t of group) {
      if (prev && prev.value === t.value && !prev.merged) {
        prev.value *= 2;
        prev.merged = true;
        gained += prev.value;
        moved = true; // t absorbed into prev
      } else {
        const { r, c } = toRC(d, line, target);
        if (r !== t.r || c !== t.c) moved = true;
        const placed: Tile = { ...t, r, c, merged: false };
        out.push(placed);
        prev = placed;
        target++;
      }
    }
  }
  return { tiles: out, gained, moved };
}

function maxTile(tiles: Tile[]): number {
  return tiles.reduce((m, t) => Math.max(m, t.value), 0);
}

function toGrid(tiles: Tile[]): number[][] {
  const g = Array.from({ length: SIZE }, () => Array<number>(SIZE).fill(0));
  for (const t of tiles) g[t.r][t.c] = t.value;
  return g;
}

function canMove(tiles: Tile[]): boolean {
  if (emptyCells(tiles).length > 0) return true;
  return (['LEFT', 'UP'] as Direction[]).some((d) => move(tiles, d).moved);
}

const COLORS: Record<number, string> = {
  2: '#eee4da', 4: '#ede0c8', 8: '#f2b179', 16: '#f59563', 32: '#f67c5f', 64: '#f65e3b',
  128: '#edcf72', 256: '#edcc61', 512: '#edc850', 1024: '#edc53f', 2048: '#edc22e',
};

function TileView({ tile }: { tile: Tile }) {
  const x = useSharedValue(tile.c);
  const y = useSharedValue(tile.r);
  const s = useSharedValue(0); // scale-in on spawn

  useEffect(() => {
    x.value = withTiming(tile.c, { duration: SLIDE_MS });
    y.value = withTiming(tile.r, { duration: SLIDE_MS });
  }, [tile.c, tile.r, x, y]);

  useEffect(() => {
    s.value = withTiming(1, { duration: SLIDE_MS });
  }, [s]);

  // Pop on merge (value change after mount).
  const mounted = useRef(false);
  useEffect(() => {
    if (mounted.current) {
      s.value = withSequence(
        withTiming(1.16, { duration: 80 }),
        withTiming(1, { duration: 80 }),
      );
    } else {
      mounted.current = true;
    }
  }, [tile.value, s]);

  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value * CELL }, { translateY: y.value * CELL }, { scale: s.value }],
  }));

  return (
    <Animated.View
      style={[styles.tile, { backgroundColor: COLORS[tile.value] ?? '#3c3a32' }, style]}
    >
      <Text style={[styles.tileText, tile.value > 4 && styles.tileTextLight]}>{tile.value}</Text>
    </Animated.View>
  );
}

export default function Game2048() {
  const [tiles, setTiles] = useState<Tile[]>(freshTiles);
  const [score, setScore] = useState(0);
  const [moves, setMoves] = useState(0);

  const grid = toGrid(tiles);
  const max = maxTile(tiles);
  const status = max >= 2048 ? 'won' : canMove(tiles) ? 'playing' : 'over';
  const stateLabel = JSON.stringify({ grid, score, max, moves, status });

  const applyMove = useCallback((dir: Direction) => {
    setTiles((cur) => {
      const res = move(cur, dir);
      if (!res.moved) return cur;
      setScore((s) => s + res.gained);
      setMoves((m) => m + 1);
      return spawn(res.tiles);
    });
  }, []);

  const reset = useCallback(() => {
    setTiles(freshTiles());
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

  const boardPx = SIZE * CELL + 8;

  return (
    <View style={styles.container} testID="game-2048-screen">
      <Text testID="board-state" accessibilityLabel={stateLabel} style={styles.state}>
        max {max} · moves {moves} · score {score} · {status}
      </Text>

      <GestureDetector gesture={pan}>
        <View style={[styles.board, { width: boardPx, height: boardPx }]} testID="board">
          {Array.from({ length: SIZE }).map((_, r) =>
            Array.from({ length: SIZE }).map((__, c) => (
              <View key={`${r}-${c}`} style={[styles.bgCell, { left: c * CELL + 4, top: r * CELL + 4 }]} />
            )),
          )}
          {tiles.map((t) => (
            <View key={t.id} style={styles.tileLayer} pointerEvents="none">
              <TileView tile={t} />
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

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#faf8ef' },
  state: { fontSize: 13, color: '#776e65', marginBottom: 16, fontVariant: ['tabular-nums'] },
  board: { backgroundColor: '#bbada0', borderRadius: 8, borderCurve: 'continuous' },
  bgCell: {
    position: 'absolute',
    width: TILE,
    height: TILE,
    borderRadius: 6,
    borderCurve: 'continuous',
    backgroundColor: '#cdc1b4',
  },
  tileLayer: { position: 'absolute', left: 4, top: 4 },
  tile: {
    width: TILE,
    height: TILE,
    borderRadius: 6,
    borderCurve: 'continuous',
    alignItems: 'center',
    justifyContent: 'center',
  },
  tileText: { fontSize: 28, fontWeight: '700', color: '#776e65' },
  tileTextLight: { color: '#f9f6f2' },
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
