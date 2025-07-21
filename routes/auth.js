// routes/auth.js
const express = require('express');
const router  = express.Router();
const authCtr = require('../controllers/authController');

router.get('/register', authCtr.getRegister);
router.post('/register', authCtr.postRegister);

router.get('/login',  authCtr.getLogin);
router.post('/login', authCtr.postLogin);

router.get('/logout', authCtr.getLogout);

module.exports = router;
