import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@chalk-format/reader/fonts.css';
import '@chalk-format/reader/styles.css';
import './app.css';
import { App } from './App.js';

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
