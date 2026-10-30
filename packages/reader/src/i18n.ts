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
    windowHint: 'Arrow keys move the window, Alt and arrow keys resize it, Escape closes it.',
    notFound: 'Not in your libraries', missingCount: '{n} items not found', missingTitle: 'Not found in your libraries', missingHint: 'Connect a library that has them, or ask whoever made this book.',
    play: 'Play', startLab: 'Start the lab', labStopped: 'The lab stopped', unsupported: 'This reader cannot show this item',
    openSnip: 'Open the snip', textPrompt: 'Type your note',
    model3d: '3D model', video: 'Video', audio: 'Sound', image: 'Image',
    notesSaved: 'Your notes were saved as a .chalk file', notesOpened: 'Notes opened', notesFailed: 'These notes could not be opened',
    signInTitle: 'Sign in to the library', username: 'Username', password: 'Password', signIn: 'Sign in', signingIn: 'Signing in…',
    signOut: 'Sign out', continueWithout: 'Continue without signing in', signInFailed: 'Could not sign in',
    wrongPassword: 'The username or password is not right.', tooManyAttempts: 'Too many tries. Wait a minute and try again.',
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
    windowHint: 'তীর চাপলে জানালা সরবে, Alt আর তীর চাপলে আকার বদলাবে, Escape চাপলে বন্ধ হবে।',
    notFound: 'আপনার লাইব্রেরিতে নেই', missingCount: '{n}টি জিনিস পাওয়া যায়নি', missingTitle: 'আপনার লাইব্রেরিগুলোতে পাওয়া যায়নি', missingHint: 'যে লাইব্রেরিতে এগুলো আছে সেটি যুক্ত করুন, অথবা বইটি যিনি বানিয়েছেন তাঁকে জানান।',
    play: 'চালাও', startLab: 'ল্যাব শুরু করো', labStopped: 'ল্যাবটি বন্ধ হয়ে গেছে', unsupported: 'এই রিডার এটি দেখাতে পারে না',
    openSnip: 'অংশটি খোলো', textPrompt: 'তোমার নোট লেখো',
    model3d: 'ত্রিমাত্রিক মডেল', video: 'ভিডিও', audio: 'শব্দ', image: 'ছবি',
    notesSaved: 'তোমার নোট একটি .chalk ফাইলে সংরক্ষিত হয়েছে', notesOpened: 'নোট খোলা হয়েছে', notesFailed: 'এই নোট খোলা গেল না',
    signInTitle: 'লাইব্রেরিতে সাইন ইন করো', username: 'ইউজারনেম', password: 'পাসওয়ার্ড', signIn: 'সাইন ইন', signingIn: 'সাইন ইন হচ্ছে…',
    signOut: 'সাইন আউট', continueWithout: 'সাইন ইন না করে চালিয়ে যাও', signInFailed: 'সাইন ইন করা গেল না',
    wrongPassword: 'ইউজারনেম বা পাসওয়ার্ড ঠিক নয়।', tooManyAttempts: 'অনেকবার চেষ্টা হয়েছে। এক মিনিট পরে আবার চেষ্টা করো।',
  },
} as const;

export type StringKey = keyof (typeof STRINGS)['en'];
export const strings = (locale: Locale) => STRINGS[locale];

/** Digits in the reader's language: ০১২৩৪৫৬৭৮৯ in Bengali. */
export function num(locale: Locale, n: number | string): string {
  const s = String(n);
  return locale === 'bn' ? s.replace(/[0-9]/g, (d) => '০১২৩৪৫৬৭৮৯'[Number(d)]!) : s;
}
