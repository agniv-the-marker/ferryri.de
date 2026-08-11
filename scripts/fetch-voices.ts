/**
 * Fetch the sampled voice bank into `public/audio/bank/`.
 *
 * One recorded instrument per synth family, four notes each an octave apart —
 * the player pitch-shifts to the nearest, so nothing is ever stretched more
 * than six semitones. That is a few hundred kilobytes total, fetched only if
 * a visitor actually switches to the sampled palette, against a site whose
 * entire JS is thirty.
 *
 * Source: MIDI.js pre-rendered soundfonts, generated from FluidR3_GM and
 * released under CC-BY 3.0 — redistributable with attribution, which is in the
 * about panel. (The MusyngKite and FatBoy fonts on the same host are
 * share-alike, so they are deliberately not used here.)
 *
 * Run with `npm run voices`. Outputs are committed, like the geo build.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const BASE = 'https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM';
const OUT = join(process.cwd(), 'public/audio/bank');

/** Which recorded instrument stands in for each synth family. */
const INSTRUMENTS: Record<string, string> = {
  reed: 'clarinet',
  pipe: 'flute',
  bowed: 'cello',
  bell: 'tubular_bells',
  plucked: 'pizzicato_strings',
  glass: 'celesta',
  wood: 'marimba',
  metal: 'vibraphone',
  hum: 'choir_aahs',
};

/** An octave apart, spanning the range the score actually uses. */
const NOTES = ['C2', 'C3', 'C4', 'C5'];

async function main() {
  await mkdir(OUT, { recursive: true });
  let total = 0;
  for (const [family, instrument] of Object.entries(INSTRUMENTS)) {
    for (const note of NOTES) {
      const url = `${BASE}/${instrument}-mp3/${note}.mp3`;
      const res = await fetch(url);
      if (!res.ok) {
        console.error(`  ${family}/${note}: ${res.status} from ${url}`);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      await writeFile(join(OUT, `${family}-${note}.mp3`), buf);
      total += buf.length;
      console.log(`  ${family.padEnd(8)} ${instrument.padEnd(20)} ${note}  ${(buf.length / 1024).toFixed(0)} KB`);
    }
  }
  console.log(`\n${(total / 1024 / 1024).toFixed(2)} MB total in ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
