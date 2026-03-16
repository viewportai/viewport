// Ensure test isolation from interactive shell exports.
// Many tests intentionally control HOME; VIEWPORT_HOME/VPD_HOME would override that path resolution.
delete process.env['VIEWPORT_HOME'];
delete process.env['VPD_HOME'];
