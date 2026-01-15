const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const target = process.argv[2] || 'all'; // all, cursor, trae, antigravity
const validTargets = ['all', 'cursor', 'trae', 'antigravity'];

if (!validTargets.includes(target)) {
    console.error(`Invalid target: ${target}. Must be one of: ${validTargets.join(', ')}`);
    process.exit(1);
}

const rootDir = path.resolve(__dirname, '..');
const pkgPath = path.join(rootDir, 'package.json');
const pkgBackupPath = path.join(rootDir, 'package.json.backup');

// Helper to restore package.json
function restorePackageJson() {
    if (fs.existsSync(pkgBackupPath)) {
        fs.copyFileSync(pkgBackupPath, pkgPath);
        fs.unlinkSync(pkgBackupPath);
        console.log('Restored original package.json');
    }
}

// Handle interrupts to restore package.json
process.on('SIGINT', () => {
    restorePackageJson();
    process.exit(1);
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    restorePackageJson();
    process.exit(1);
});

try {
    // Backup package.json
    // Check if backup already exists (crashed previous run), if so, restore first
    if (fs.existsSync(pkgBackupPath)) {
        console.warn('Found existing backup, restoring first...');
        fs.copyFileSync(pkgBackupPath, pkgPath);
    }
    
    fs.copyFileSync(pkgPath, pkgBackupPath);
    console.log(`Backed up package.json to ${pkgBackupPath}`);

    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

    // Modify package.json based on target
    if (target !== 'all') {
        const properName = target.charAt(0).toUpperCase() + target.slice(1);
        
        // Update metadata
        pkg.name = `${target}-usage`;
        pkg.displayName = `${properName} Usage`;
        pkg.description = `${properName} usage statistics`;
        
        // Filter commands
        if (pkg.contributes && pkg.contributes.commands) {
            pkg.contributes.commands = pkg.contributes.commands.filter(cmd => {
                if (cmd.command === 'cursorUsage.handleCursorClick' && target !== 'cursor') return false;
                if (cmd.command === 'cursorUsage.handleTraeClick' && target !== 'trae') return false;
                if (cmd.command === 'cursorUsage.handleAntigravityClick' && target !== 'antigravity') return false;
                return true;
            });
            
            // Update command titles
            pkg.contributes.commands.forEach(cmd => {
                if (cmd.title.startsWith('Coding Usage:')) {
                    cmd.title = cmd.title.replace('Coding Usage:', `${properName} Usage:`);
                }
            });
        }
        
        // Filter configuration
        if (pkg.contributes && pkg.contributes.configuration && pkg.contributes.configuration.properties) {
             // Remove showAllProviders for specific builds
             delete pkg.contributes.configuration.properties['cursorUsage.showAllProviders'];
             
             // Optionally update titles in configuration
             pkg.contributes.configuration.title = `${properName} Usage`;
        }
    }

    // Write modified package.json
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
    console.log(`Updated package.json for target: ${target}`);

    // Run build (esbuild) with env var
    console.log(`Packaging for target: ${target}...`);
    
    // Execute vsce package
    // We pass EXTENSION_TARGET in env so esbuild (called by npm run package) can pick it up
    execSync('npx --yes @vscode/vsce package', { 
        stdio: 'inherit', 
        cwd: rootDir,
        env: { ...process.env, EXTENSION_TARGET: target }
    });
    
    console.log(`Successfully packaged for ${target}`);

} catch (e) {
    console.error('Error during packaging:', e);
    process.exit(1);
} finally {
    restorePackageJson();
}
