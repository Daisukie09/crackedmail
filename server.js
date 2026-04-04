const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cookie = require('cookie');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE = 'https://www.phantommail.shop/public/';

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
