const fs = require('fs');
const path = require('path');

// Read the test accounts file
const filePath = path.join(__dirname, 'test_accounts.json');
const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

let convertedCount = 0;
let totalReportsUpdated = 0;

// Process each account
data.forEach(account => {
    let accountHasBusiness = false;

    // Process each usage report
    account.usage_reports.forEach(report => {
        if (report.membership_type === 'business') {
            accountHasBusiness = true;
            totalReportsUpdated++;

            // Convert to pro
            report.membership_type = 'pro';

            // Update usage: business has 5000, pro has 2000
            // Calculate the usage ratio to maintain the same percentage
            const usageRatio = report.used_usage / report.total_usage;

            report.total_usage = 2000;
            report.used_usage = Math.round(usageRatio * 2000);
            report.remaining_usage = report.total_usage - report.used_usage;
        }
    });

    if (accountHasBusiness) {
        convertedCount++;
        console.log(`Converted account: ${account.email}`);
    }
});

// Write the updated data back to the file
fs.writeFileSync(filePath, JSON.stringify(data, null, 4));

console.log(`\n✅ Conversion complete!`);
console.log(`📊 Statistics:`);
console.log(`   - Accounts converted: ${convertedCount}`);
console.log(`   - Total usage reports updated: ${totalReportsUpdated}`);
console.log(`   - File updated: ${filePath}`);
