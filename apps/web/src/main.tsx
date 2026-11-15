import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ConvexProvider, ConvexReactClient } from 'convex/react';
import { App } from './App';
import { env } from './lib/env';
import './styles/app.css';

// Convex = the real-time live build feed (services/live). Optional: without VITE_CONVEX_URL the panel hides.
const convex = env.convexUrl ? new ConvexReactClient(env.convexUrl) : null;
const app = <StrictMode><App /></StrictMode>;
createRoot(document.getElementById('root')!).render(convex ? <ConvexProvider client={convex}>{app}</ConvexProvider> : app);
