exports.getLanding = (req, res) => res.render('landing');
exports.getDashboard = (req, res) => {
  res.render('dashboard', { title: 'Dashboard' });
};

