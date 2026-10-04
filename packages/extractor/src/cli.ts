import { Effect, Option, Path } from 'effect';
import { Command, Flag } from 'effect/cli';

import { type ImageFormat, PipelineContext } from './domain/context.ts';
import { runPipeline } from './pipeline.ts';

// `--clean`: re-extract the dvdbnd archives from scratch — restore backups and
// delete previously-unpacked dirs first (e.g. to refresh after a game patch).
const clean = Flag.Boolean('clean').pipe(
  Flag.withDefault(false),
  Flag.withDescription(
    'Re-extract from scratch: restore backups + delete previously-unpacked dirs.',
  ),
);

// `--game-dir` / `-g`: the Elden Ring install folder (the one containing `Game/`),
// e.g. `C:\Program Files (x86)\Steam\steamapps\common\ELDEN RING`.
const gameDir = Flag.Directory('game-dir', { mustExist: true }).pipe(
  Flag.withAlias('g'),
  Flag.withDescription(
    'Path to the Elden Ring install folder (the directory containing Game/).',
  ),
);

// `--out` / `-o`: where extracted artifacts (and the generated data files) land.
const outDir = Flag.Directory('out').pipe(
  Flag.withAlias('o'),
  Flag.withDefault('.er-extractor-out'),
  Flag.withDescription('Directory to write extracted artifacts into.'),
);

// `--image-format` / `--image-quality`: encoding for the images stage. WebP at
// q80 keeps tiles small; png is lossless; avif is smallest but slowest.
const imageFormat = Flag.Literals('image-format', [
  'webp',
  'png',
  'jpeg',
  'avif',
]).pipe(
  Flag.withDefault('webp' as ImageFormat),
  Flag.withDescription('Output format for extracted images (default webp).'),
);
const imageQuality = Flag.Int('image-quality').pipe(
  Flag.withDefault(80),
  Flag.withDescription('Quality 1–100 for lossy image formats (default 80).'),
);

// `--skip-images`: skip the images stage (map tiles + icons) and keep whatever is
// already under `packages/data/images/`. Regenerating only the data files this way
// doesn't need the Rust image codec (`build:image-codec`) to be built.
const skipImages = Flag.Boolean('skip-images').pipe(
  Flag.withDefault(false),
  Flag.withDescription(
    'Skip the images stage (keep existing tiles/icons); regenerate data files only.',
  ),
);

// `--unpack-dir`: unpack into this dir instead of the install's `Game/` folder, and only
// the files the pipeline reads (msg/event/mapstudio, + map/menu textures unless
// `--skip-images`) — ~29 MB of data instead of the full ~68 GB archive set. The install
// is then only ever read (archives, regulation.bin, the Oodle DLL, eldenring.exe).
const unpackDir = Flag.Directory('unpack-dir').pipe(
  Flag.optional,
  Flag.withDescription(
    'Unpack only the needed game files into this dir instead of the install (read-only install).',
  ),
);

/** Archive paths the pipeline reads, for a filtered `--unpack-dir` unpack. */
const DATA_PATHS = [
  /^\/msg\/engus\//,
  /^\/event\/.*\.emevd\.dcx$/,
  /^\/map\/mapstudio\/.*\.msb\.dcx$/,
];
const IMAGE_PATHS = [/^\/menu\/71_maptile\./, /^\/menu\/hi\/0[0-3]_/];

const extract = Command.make(
  'extract',
  { gameDir, outDir, clean, imageFormat, imageQuality, skipImages, unpackDir },
  ({
    gameDir,
    outDir,
    clean,
    imageFormat,
    imageQuality,
    skipImages,
    unpackDir,
  }) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const wanted = skipImages ? DATA_PATHS : [...DATA_PATHS, ...IMAGE_PATHS];
      yield* runPipeline.pipe(
        Effect.provideService(PipelineContext, {
          gameDir,
          gameRoot: path.join(gameDir, 'Game'),
          outDir,
          clean,
          imageFormat,
          imageQuality,
          skipImages,
          unpackRoot: Option.match(unpackDir, {
            onNone: () => path.join(gameDir, 'Game'),
            onSome: (dir) => path.resolve(dir),
          }),
          unpackInclude: Option.isSome(unpackDir)
            ? (archivePath: string) => wanted.some((re) => re.test(archivePath))
            : undefined,
        }),
      );
    }),
);

const root = Command.make('er-extractor').pipe(
  Command.withSubcommands([extract]),
);

export const cli = Command.run(root, {
  version: '0.0.0',
});
