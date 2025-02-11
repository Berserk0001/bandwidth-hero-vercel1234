#!/usr/bin/env node
'use strict';

import express from 'express';

import authenticate from './src/authenticate.js';
import params from './src/params.js';
import proxy from './src/proxy.js';


const app = express();
const PORT =8080;



// Trust proxy for secure cookies and HTTPS redirection
app.enable('trust proxy');

// Routes
app.get('/', authenticate, params, proxy);

// Handle favicon requests
app.get('/favicon.ico', (req, res) => res.status(204).end());

// Start server
app.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`);
});
