// Most tests exercise the real approval gate/backend path, which is gated behind
// AEGMIS_APPROVAL (disabled by default in production). Enable it globally here;
// the auto-approve default is covered by a dedicated test that overrides it.
process.env.AEGMIS_APPROVAL = "true";
