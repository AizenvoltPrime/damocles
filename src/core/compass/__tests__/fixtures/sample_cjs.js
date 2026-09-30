const { inspect } = require('util');

module.exports = {
	greet: (name) => `hello ${name}`,
	namespace: {
		helper: function (value) {
			return inspect(value);
		},
		deep: {
			compute: () => 42,
		},
	},
};

module.exports.named = function (a, b) {
	return a + b;
};

exports.shortcut = () => 'short';

class LegacyShape {
	area() { return 0; }
}

module.exports.Shape = LegacyShape;
