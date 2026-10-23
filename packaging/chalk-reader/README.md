# @chalk-fmt/reader

The reader and editor for **`.chalk` books**, as one configurable React component: pages, search, the student's
notes, video, sound, 3D models, labs, streamed books, media libraries and an author mode. Bilingual (Bengali and
English), phone first.

```bash
npm i @chalk-fmt/reader @chalk-fmt/core react react-dom
```

```tsx
import { ChalkReader } from '@chalk-fmt/reader';
import '@chalk-fmt/reader/fonts.css';     // Noto Sans + Noto Sans Bengali (skip if your app already loads them)
import '@chalk-fmt/reader/styles.css';

export function Book() {
  return <ChalkReader source="/books/physics-9.chalk" />;   // a .chalk URL, bytes, a File, or a streamed book's folder
}
```

Every feature is configurable through one `config` prop, and author mode is one setting away
(`config={{ authoring: { enabled: true } }}`). Media a book does not carry comes from the libraries you connect:

```tsx
import { registryLibrary } from '@chalk-fmt/core';
<ChalkReader source={url} libraries={[registryLibrary({ url: 'https://library.example.org' })]} />
```

The full list of props and settings: [the reader's README](https://github.com/runagent-dev/chalk-format/tree/main/packages/reader#readme).
Guides and the specification: https://github.com/runagent-dev/chalk-format. Apache-2.0.
