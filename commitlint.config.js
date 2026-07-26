module.exports = {
  extends: ["@commitlint/config-conventional"],
  rules: {
    // config-conventional defaults both to 100, which is tight for bodies
    // containing prose, bullet lists or URLs.
    "body-max-line-length": [2, "always", 200],
    "footer-max-line-length": [2, "always", 200],
  },
};
