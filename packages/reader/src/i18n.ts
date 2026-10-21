import type { Locale } from './config.js';

/** The reader's own words. Book content is never translated; only the chrome around it. */
const STRINGS = {
  en: {
    loading: 'Opening the book…', failed: 'This book could not be opened', page: 'Page', of: 'of',
    prev: 'Previous page', next: 'Next page', goTo: 'Go to page',
    zoomIn: 'Zoom in', zoomOut: 'Zoom out', fitWidth: 'Fit width', fitPage: 'Fit page',
    layout: 'Page layout', continuous: 'Scroll', single: 'One page', spread: 'Two pages',
    thumbnails: 'Pages', search: 'Search', searchPlaceholder: 'Search this book', noResults: 'No matches', results: 'matches',
    tools: 'Tools', undo: 'Undo', redo: 'Redo',
    pan: 'Move', select: 'Select', pen: 'Pen', highlighter: 'Highlighter', eraser: 'Eraser', text: 'Text',
    rect: 'Rectangle', ellipse: 'Ellipse', line: 'Line', arrow: 'Arrow', color: 'Colour', size: 'Size',
    export: 'Save my notes', import: 'Open notes', clear: 'Clear my notes on this page',
    theme: 'Dark mode', language: 'বাংলা', fullscreen: 'Full screen', close: 'Close',
    play: 'Play', startLab: 'Start the lab', labStopped: 'The lab stopped', unsupported: 'This reader cannot show this item',
    openSnip: 'Open the snip', textPrompt: 'Type your note',
    model3d: '3D model', video: 'Video', audio: 'Sound', image: 'Image',
    notesSaved: 'Your notes were saved as a .chalk file', notesOpened: 'Notes opened', notesFailed: 'These notes could not be opened',
  },
  bn: {
    loading: 'বইটি খোলা হচ্ছে…', failed: 'বইটি খোলা গেল না', page: 'পৃষ্ঠা', of: '/',
    prev: 'আগের পৃষ্ঠা', next: 'পরের পৃষ্ঠা', goTo: 'পৃষ্ঠায় যাও',
    zoomIn: 'বড় করো', zoomOut: 'ছোট করো', fitWidth: 'প্রস্থে মানাও', fitPage: 'পুরো পৃষ্ঠা',
    layout: 'পৃষ্ঠা বিন্যাস', continuous: 'স্ক্রল', single: 'এক পৃষ্ঠা', spread: 'দুই পৃষ্ঠা',
    thumbnails: 'পৃষ্ঠাগুলো', search: 'খোঁজো', searchPlaceholder: 'বইয়ে খোঁজো', noResults: 'কিছু পাওয়া যায়নি', results: 'টি পাওয়া গেছে',
    tools: 'সরঞ্জাম', undo: 'ফিরিয়ে নাও', redo: 'আবার করো',
    pan: 'সরাও', select: 'বাছাই', pen: 'কলম', highlighter: 'হাইলাইটার', eraser: 'রাবার', text: 'লেখা',
    rect: 'আয়তক্ষেত্র', ellipse: 'উপবৃত্ত', line: 'রেখা', arrow: 'তীর', color: 'রং', size: 'আকার',
    export: 'আমার নোট সংরক্ষণ', import: 'নোট খোলো', clear: 'এই পৃষ্ঠার আমার নোট মুছে ফেলো',
    theme: 'অন্ধকার মোড', language: 'English', fullscreen: 'পূর্ণ পর্দা', close: 'বন্ধ করো',
    play: 'চালাও', startLab: 'ল্যাব শুরু করো', labStopped: 'ল্যাবটি বন্ধ হয়ে গেছে', unsupported: 'এই রিডার এটি দেখাতে পারে না',
    openSnip: 'অংশটি খোলো', textPrompt: 'তোমার নোট লেখো',
    model3d: 'ত্রিমাত্রিক মডেল', video: 'ভিডিও', audio: 'শব্দ', image: 'ছবি',
    notesSaved: 'তোমার নোট একটি .chalk ফাইলে সংরক্ষিত হয়েছে', notesOpened: 'নোট খোলা হয়েছে', notesFailed: 'এই নোট খোলা গেল না',
  },
} as const;

export type StringKey = keyof (typeof STRINGS)['en'];
export const strings = (locale: Locale) => STRINGS[locale];

/** Digits in the reader's language: ০১২৩৪৫৬৭৮৯ in Bengali. */
export function num(locale: Locale, n: number | string): string {
  const s = String(n);
  return locale === 'bn' ? s.replace(/[0-9]/g, (d) => '০১২৩৪৫৬৭৮৯'[Number(d)]!) : s;
}
