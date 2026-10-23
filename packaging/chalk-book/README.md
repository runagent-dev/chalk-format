# @chalk-fmt/book

The **`.chalk` interactive book format** for JavaScript and TypeScript: the data model, reading and writing `.chalk`
files, asset keys and stores, media libraries, and running labs.

A `.chalk` book is pages (a rendered PDF page, an image or a colour) with objects placed on them: ink, text, images,
video, sound, 3D models and labs, with a text layer for search. Media is named by keys made from its bytes.

```bash
npm i @chalk-fmt/book
```

```ts
import { unpackLesson, packLesson, assetKey, registryLibrary } from '@chalk-fmt/book';

const { lesson, assets } = await unpackLesson(bytes);          // open a .chalk
console.log(lesson.title, lesson.pages.length);
const again = await packLesson(lesson, assets);                 // write it back

const key = await assetKey(videoBytes);                         // 'c1:…', the same for the same bytes everywhere
const library = registryLibrary({ url: 'https://library.example.org' });
const found = await library.search({ q: 'pendulum', types: ['video/*'] });
```

Labs talk to the reader through `@chalk-fmt/book/lab/client`:

```ts
import { connectLab } from '@chalk-fmt/book/lab/client';
const lab = await connectLab({ id: 'org.example.pendulum', version: '1.0.0' });
```

Related packages: [`@chalk-fmt/reader`](https://www.npmjs.com/package/@chalk-fmt/reader) (the React reader and editor),
[`@chalk-fmt/pdf`](https://www.npmjs.com/package/@chalk-fmt/pdf) (PDF → `.chalk`),
[`@chalk-fmt/library-server`](https://www.npmjs.com/package/@chalk-fmt/library-server) (run a media library).

The specification, guides and source: https://github.com/runagent-dev/chalk-format. Apache-2.0.
