const express = require('express');
const { requireBody } = require('../utils/middleware');
const { authenticate } = require('../utils/authMiddleware');

const router = express.Router();

router.get('/friends', authenticate, requireBody, async(req, res)=> {})
router.post('/addfriend', authenticate, requireBody, async(req, res)=> {})


module.exports = router;