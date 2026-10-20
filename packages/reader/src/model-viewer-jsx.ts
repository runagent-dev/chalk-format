import type { DetailedHTMLProps, HTMLAttributes } from 'react';

// <model-viewer> (@google/model-viewer), loaded on demand by render/Embeds.tsx.
type ModelViewerProps = DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
  src?: string; poster?: string | undefined; 'camera-controls'?: string; 'touch-action'?: string; 'shadow-intensity'?: string;
  exposure?: string; 'environment-image'?: string; 'interaction-prompt'?: string; 'auto-rotate'?: string;
};
declare module 'react' {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- React declares JSX as a namespace; augmenting it takes the same form
  namespace JSX { interface IntrinsicElements { 'model-viewer': ModelViewerProps } }
}

export {};
