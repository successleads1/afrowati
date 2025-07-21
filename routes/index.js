const express = require('express');
const router  = express.Router();
const { ensureAuthenticated } = require('../middleware/auth');
const idxCtr  = require('../controllers/indexController');

router.get('/', idxCtr.getLanding);

router.get(
  '/dashboard',
  ensureAuthenticated,
  idxCtr.getDashboard
);

module.exports = router;
