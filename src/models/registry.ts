/** A gallery exhibit. `mount` builds it into `host` and returns a disposer. */
export interface GalleryModel {
  id: string;
  title: string;
  titleBn: string;
  subject: 'physics' | 'chemistry' | 'biology' | 'math';
  level: string;
  summary: string;
  /** Poster image for the gallery card (a real render; no 3D runs on the index page). */
  poster: string;
  mount(host: HTMLElement): Promise<() => void>;
}

export const MODELS: GalleryModel[] = [
  {
    id: 'screw-gauge',
    title: 'Screw gauge',
    titleBn: 'স্ক্রু গজ',
    subject: 'physics',
    level: 'SSC · HSC',
    summary: 'Turn the thimble, measure a wire or a ball, find the least count and correct the zero error.',
    poster: '/posters/screw-gauge.jpg',
    mount: async (host) => (await import('./screw-gauge/page')).mountScrewGauge(host),
  },
  {
    id: 'vernier-caliper',
    title: 'Vernier caliper',
    titleBn: 'ভার্নিয়ার ক্যালিপার্স',
    subject: 'physics',
    level: 'SSC · HSC',
    summary: 'Slide the jaws to measure outside, inside and depth; find the coinciding division and correct the zero error.',
    poster: '/posters/vernier-caliper.jpg',
    mount: async (host) => (await import('./vernier/page')).mountVernier(host),
  },
];
