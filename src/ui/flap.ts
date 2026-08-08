/**
 * A split-flap ("Solari") departure board, paper-and-ink edition — an homage
 * to the Ferry Building's boards. Each cell is a character card that flips
 * around its horizontal midline when its value changes, with a small cascade
 * stagger and a couple of intermediate characters for that clattering feel.
 */
import { T } from '../lib/tunables';

const CYCLE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789:→ ';

export interface FlapColumn {
  /** number of character cells */
  width: number;
  align: 'left' | 'right';
}

export class FlapBoard {
  readonly el = document.createElement('div');
  private rows: { el: HTMLElement; cells: HTMLElement[]; text: string }[] = [];
  /** In-flight character timers per cell, so a new value cancels the old. */
  private timers = new Map<HTMLElement, ReturnType<typeof setTimeout>[]>();

  constructor(
    private columns: FlapColumn[],
    private rowCount: number,
  ) {
    this.el.className = 'flap-board';
    for (let r = 0; r < rowCount; r++) {
      const row = document.createElement('div');
      row.className = 'flap-row';
      const cells: HTMLElement[] = [];
      this.columns.forEach((col, ci) => {
        if (ci > 0) {
          const gap = document.createElement('span');
          gap.className = 'flap-gap';
          row.append(gap);
        }
        for (let i = 0; i < col.width; i++) {
          const cell = document.createElement('span');
          cell.className = 'flap-cell';
          const face = document.createElement('span');
          face.textContent = ' ';
          cell.append(face);
          row.append(cell);
          cells.push(cell);
        }
      });
      this.el.append(row);
      this.rows.push({ el: row, cells, text: '' });
    }
  }

  /**
   * Update the board. Each row: column texts + an accent color for the row's
   * left tick. Missing rows blank out.
   */
  update(data: { cols: string[]; accent?: string }[]) {
    for (let r = 0; r < this.rowCount; r++) {
      const row = this.rows[r]!;
      const d = data[r];
      const padded = this.columns
        .map((col, ci) => {
          const raw = (d?.cols[ci] ?? '').toUpperCase().slice(0, col.width);
          return col.align === 'right'
            ? raw.padStart(col.width, ' ')
            : raw.padEnd(col.width, ' ');
        })
        .join('');
      row.el.style.borderLeftColor = d?.accent ?? 'transparent';
      if (padded === row.text) continue;
      const prev = row.text.padEnd(padded.length, ' ');
      row.text = padded;
      for (let i = 0; i < padded.length; i++) {
        if (padded[i] === prev[i]) continue;
        // every fill clatters in — cells cascade left-to-right, rows top-down
        this.flipCell(row.cells[i]!, padded[i]!, i, r);
      }
    }
  }

  /**
   * Flip one cell to `target`, clattering through a couple of throwaway
   * characters on the way.
   *
   * The characters are advanced by timers and the rotation is decoration
   * layered on top — never the other way round. Animation callbacks are not
   * guaranteed to fire (a backgrounded tab, a dropped frame, an interrupting
   * update), and a board that silently keeps a blank or stale character is
   * worse than one that doesn't animate.
   */
  private flipCell(cell: HTMLElement, target: string, index: number, row: number) {
    const face = cell.firstElementChild as HTMLElement;
    const pending = this.timers.get(cell);
    if (pending) pending.forEach(clearTimeout);
    this.timers.set(cell, []);

    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      face.textContent = target;
      return;
    }

    const stagger = index * T.flapStagger + row * T.flapRowStagger;
    const half = Math.max(30, T.flapMs);
    const seq: string[] = [];
    for (let c = 0; c < Math.round(T.flapCycles); c++)
      seq.push(CYCLE_CHARS[Math.floor(Math.random() * CYCLE_CHARS.length)]!);
    seq.push(target);

    const timers = this.timers.get(cell)!;
    seq.forEach((ch, k) => {
      timers.push(
        setTimeout(() => {
          face.textContent = ch;
          face.getAnimations().forEach((a) => a.cancel());
          face.animate(
            [
              { transform: 'rotateX(84deg)' },
              { transform: 'rotateX(0deg)' },
            ],
            { duration: half, easing: 'ease-out' },
          );
        }, stagger + k * half * 2),
      );
    });
  }
}
