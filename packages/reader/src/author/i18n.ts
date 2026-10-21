import type { Locale } from '../config.js';

/** Author mode's own words (the reader's are in ../i18n.ts). */
const STRINGS = {
  en: {
    edit: 'Edit this book', preview: 'Preview as a student', add: 'Add media', save: 'Save the book', saved: 'Book saved', saveFailed: 'The book was not saved',
    unsaved: 'Unsaved changes', leave: 'This book has unsaved changes. Leave anyway?', notPlaceable: 'This file cannot be added',
    properties: 'Properties', nothing: 'Select something on the page to change how it is shown. Add media with the + button, or drop files on a page.',
    display: 'On the page', full: 'Full size', icon: 'Small icon',
    show: 'Before it is tapped', card: 'Thumbnail', live: 'Live',
    open: 'A tap opens it', inline: 'In place', popup: 'In a window', fullscreen: 'Full screen', none: 'Nothing',
    label: 'Label', labelHint: 'Shown on the thumbnail, and read out by screen readers',
    iconPick: 'Icon', iconDefault: 'Default', accent: 'Colour', accentNone: "Reader's colour",
    playback: 'Playback', autoplay: 'Play by itself (silently)', loop: 'Play again at the end', muted: 'Without sound', autoRotate: 'Turn slowly',
    presentation: 'Presentation', look: 'Appearance', style: 'Style', position: 'Position and size', front: 'Bring to front', back: 'Send to back',
    book: 'Book', title: 'Title', page: 'Page', pageTitle: 'Page title', background: 'Background', bgPicture: 'a picture (from the PDF)',
    layers: 'On this page', noLayers: 'Nothing on this page yet.', chooseFile: 'Choose a file', dropHere: 'or drop it here, or on a page',
    addNote: 'How it will be presented once added. Change it any time by selecting it.', toolHint: 'For what you draw next.',
    eraserHint: 'Drag over drawings, text and shapes to erase them. To remove media, select it and delete it.',
    tools: 'Tools', shapes: 'Shapes', text: 'Text', textSize: 'Text size', fill: 'Fill', noFill: 'No fill', stroke: 'Line', thickness: 'Thickness',
    labTitle: 'Lab name', remove: 'Delete', resize: 'Resize', drop: 'Drop to add to this page',
    rect: 'Rectangle', ellipse: 'Ellipse', line: 'Line', arrow: 'Arrow', ink: 'Drawing', vector: 'Drawing',
    image: 'Image', video: 'Video', audio: 'Sound', model3d: '3D model', lab: 'Lab', plugin: 'Widget', snip: 'Snip', other: 'Object',
  },
  bn: {
    edit: 'বইটি সম্পাদনা করুন', preview: 'শিক্ষার্থীর চোখে দেখুন', add: 'মিডিয়া যোগ করুন', save: 'বইটি সংরক্ষণ করুন', saved: 'বই সংরক্ষিত হয়েছে', saveFailed: 'বইটি সংরক্ষণ করা যায়নি',
    unsaved: 'পরিবর্তন সংরক্ষণ করা হয়নি', leave: 'বইটির পরিবর্তন সংরক্ষণ করা হয়নি। তবুও বের হবেন?', notPlaceable: 'এই ফাইলটি যোগ করা যায় না',
    properties: 'বৈশিষ্ট্য', nothing: 'পাতার কিছু নির্বাচন করুন, তারপর এটি কীভাবে দেখাবে তা বদলান। + বোতাম দিয়ে মিডিয়া যোগ করুন, অথবা ফাইল পাতার ওপর ছেড়ে দিন।',
    display: 'পাতায়', full: 'পূর্ণ আকারে', icon: 'ছোট আইকন',
    show: 'ট্যাপ করার আগে', card: 'থাম্বনেইল', live: 'সরাসরি',
    open: 'ট্যাপ করলে খুলবে', inline: 'এখানেই', popup: 'আলাদা জানালায়', fullscreen: 'পূর্ণ পর্দায়', none: 'কিছু না',
    label: 'লেবেল', labelHint: 'থাম্বনেইলে দেখা যাবে, স্ক্রিন রিডার পড়ে শোনাবে',
    iconPick: 'আইকন', iconDefault: 'স্বাভাবিক', accent: 'রং', accentNone: 'রিডারের রং',
    playback: 'চালানো', autoplay: 'নিজে থেকে চালু হবে (শব্দ ছাড়া)', loop: 'শেষ হলে আবার চলবে', muted: 'শব্দ ছাড়া', autoRotate: 'ধীরে ঘুরবে',
    presentation: 'উপস্থাপন', look: 'চেহারা', style: 'ধরন', position: 'অবস্থান ও আকার', front: 'সবার সামনে আনুন', back: 'সবার পেছনে পাঠান',
    book: 'বই', title: 'শিরোনাম', page: 'পাতা', pageTitle: 'পাতার শিরোনাম', background: 'পটভূমি', bgPicture: 'একটি ছবি (PDF থেকে)',
    layers: 'এই পাতায় যা আছে', noLayers: 'এই পাতায় এখনো কিছু নেই।', chooseFile: 'একটি ফাইল বেছে নিন', dropHere: 'অথবা এখানে বা পাতার ওপর ছেড়ে দিন',
    addNote: 'যোগ করার পর এভাবে দেখাবে। পরে নির্বাচন করে যেকোনো সময় বদলাতে পারবেন।', toolHint: 'পরের বার যা আঁকবেন তার জন্য।',
    eraserHint: 'আঁকা, লেখা ও আকৃতির ওপর দিয়ে টানলে মুছে যাবে। মিডিয়া সরাতে সেটি নির্বাচন করে মুছুন।',
    tools: 'সরঞ্জাম', shapes: 'আকৃতি', text: 'লেখা', textSize: 'লেখার আকার', fill: 'ভরাট', noFill: 'ভরাট নেই', stroke: 'রেখা', thickness: 'পুরুত্ব',
    labTitle: 'ল্যাবের নাম', remove: 'মুছুন', resize: 'আকার বদলান', drop: 'এই পাতায় যোগ করতে এখানে ছাড়ুন',
    rect: 'আয়তক্ষেত্র', ellipse: 'উপবৃত্ত', line: 'রেখা', arrow: 'তীর', ink: 'আঁকা', vector: 'আঁকা',
    image: 'ছবি', video: 'ভিডিও', audio: 'শব্দ', model3d: 'ত্রিমাত্রিক মডেল', lab: 'ল্যাব', plugin: 'উইজেট', snip: 'স্নিপ', other: 'বস্তু',
  },
};

export type AuthorStrings = (typeof STRINGS)['en'];
export const authorStrings = (locale: Locale): AuthorStrings => STRINGS[locale];
