import db from '../store.js';
import { KnowledgeGraph } from './graph.js';

/** The one graph of ideas, in the app's own SQLite file. */
export const graph = new KnowledgeGraph(db);
