// Quick CLI test for email payment verification.
// Usage: npx tsx test-email.ts <email> <password> [host]
// Example: npx tsx test-email.ts me@gmail.com abcd1234efgh5678
// Example: npx tsx test-email.ts me@outlook.com mypass imap.outlook.com

import { testPaymentEmail, checkEmailPayment, inspectLatestPaymentEmail } from './email-payments.ts';

const [,, email, password, host] = process.argv;

if (!email || !password) {
  console.error('Usage: npx tsx test-email.ts <email> <password> [host]');
  console.error('');
  console.error('Examples:');
  console.error('  npx tsx test-email.ts me@gmail.com app-password-here');
  console.error('  npx tsx test-email.ts me@outlook.com mypassword imap.outlook.com');
  console.error('');
  console.error('Gmail users: use an App Password from myaccount.google.com/apppasswords');
  process.exit(1);
}

const config = { email, password, host: host || undefined };

async function run() {
  console.log(`\n🔌 Testing IMAP connection to ${email}${host ? ` (host: ${host})` : ''}...\n`);

  // Step 1: Connection test
  try {
    await testPaymentEmail(config);
    console.log('✅ Connection successful — IMAP credentials are working.\n');
  } catch (err: any) {
    console.error('❌ Connection failed:', err.message);
    process.exit(1);
  }

  // Step 2: Scan inbox for recent payment emails
  console.log('🔍 Scanning inbox for recent payment emails (last 60 min)...\n');
  try {
    const result = await inspectLatestPaymentEmail(config, undefined, undefined, 60);

    if (!result) {
      console.log('📭 No payment-looking emails found in the last 60 minutes.');
      console.log('   Try sending a test payment to yourself, then re-run this script.');
    } else {
      console.log('📧 Most recent payment email found:');
      console.log(`   UID:      ${result.uid}`);
      console.log(`   From:     ${result.from}`);
      console.log(`   Subject:  ${result.subject}`);
      console.log(`   Date:     ${result.date}`);
      console.log(`   Provider: ${result.provider}`);
      console.log(`   Amounts:  ${result.amountsFound.length ? result.amountsFound.map(a => `$${a.toFixed(2)}`).join(', ') : 'none detected'}`);
      console.log(`   Memo:     ${result.memo || '(none found)'}`);
      if (result.bodySnippet) {
        console.log(`\n   Body snippet:\n   ${result.bodySnippet.slice(0, 300).replace(/\n/g, '\n   ')}`);
      }
    }
  } catch (err: any) {
    console.error('❌ Inbox scan failed:', err.message);
  }

  // Step 3: Optional — test a specific amount + order ID
  const testAmount  = parseFloat(process.env.TEST_AMOUNT  || '');
  const testOrderId = process.env.TEST_ORDER_ID || '';
  const testProvider = (process.env.TEST_PROVIDER || '') as any;

  if (testAmount && testOrderId && testProvider) {
    console.log(`\n🧪 Verifying specific payment: provider=${testProvider} amount=$${testAmount} orderId=${testOrderId}...\n`);
    try {
      const uid = await checkEmailPayment(testProvider, testAmount, testOrderId, config, 60, new Set());
      if (uid) {
        console.log(`✅ Payment FOUND — email UID: ${uid}`);
      } else {
        console.log('❌ Payment NOT found. Check that the amount and order ID match what is in the email note.');
      }
    } catch (err: any) {
      console.error('❌ Verification error:', err.message);
    }
  } else if (testAmount || testOrderId || testProvider) {
    console.log('\n💡 To verify a specific payment, set all three env vars:');
    console.log('   TEST_PROVIDER=cashapp TEST_AMOUNT=12.50 TEST_ORDER_ID=XMO4917H npx tsx test-email.ts <email> <password>');
  }

  console.log('');
}

run();
