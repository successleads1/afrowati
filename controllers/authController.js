// controllers/authController.js
const bcrypt   = require('bcryptjs');
const passport = require('passport');
const User     = require('../models/User');

// Render the “Register” form
exports.getRegister = (req, res) => {
  res.render('register', {
    errors:    [],     // always pass an array to avoid “errors is not defined”
    name:      '',
    email:     '',
    password:  '',
    password2: ''
  });
};

// Handle the register POST
exports.postRegister = async (req, res) => {
  const { name, email, password, password2 } = req.body;
  const errors = [];

  if (!name || !email || !password || !password2)
    errors.push({ msg: 'Please fill in all fields' });
  if (password !== password2)
    errors.push({ msg: 'Passwords do not match' });
  if (password.length < 6)
    errors.push({ msg: 'Password must be at least 6 characters' });

  if (errors.length) {
    return res.render('register', { errors, name, email, password, password2 });
  }

  try {
    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) {
      errors.push({ msg: 'Email already exists' });
      return res.render('register', { errors, name, email, password, password2 });
    }

    const newUser = new User({ name, email: email.toLowerCase(), password });
    const salt    = await bcrypt.genSalt(10);
    newUser.password = await bcrypt.hash(password, salt);
    await newUser.save();

    req.flash('success_msg', 'You are now registered and can log in');
    res.redirect('/auth/login');
  } catch (err) {
    console.error(err);
    res.render('register', {
      errors:    [{ msg: 'Server error. Please try again.' }],
      name, email, password, password2
    });
  }
};

// Render the “Login” form
exports.getLogin = (req, res) => {
  res.render('login', {
    error_msg: req.flash('error_msg'),
    error:     req.flash('error')
  });
};

// Handle the login POST via Passport
exports.postLogin = (req, res, next) => {
  passport.authenticate('local', {
    successRedirect: '/setup',      // → your wizard
    failureRedirect: '/auth/login',
    failureFlash:    true
  })(req, res, next);
};

// Logout
exports.getLogout = (req, res) => {
  req.logout(err => {
    if (err) console.error(err);
    req.flash('success_msg', 'You are logged out');
    res.redirect('/auth/login');
  });
};
