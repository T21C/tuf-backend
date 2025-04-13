import { emailService } from '../utils/email.js';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Configuration
const TEST_EMAIL = process.argv[2]; // Replace with your test email

async function main() {
  console.log('Starting email test...');
  console.log(`Sending test email to: ${TEST_EMAIL}`);
  
  const subject = 'TUF Email Test';
  const text = `
    This is a test email from The Universal Forums.
    
    If you're receiving this, the email service is working correctly.
    
    Sent at: ${new Date().toISOString()}
  `;
  
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #4CAF50;">TUF Email Test</h2>
      <p>This is a test email from The Universal Forums.</p>
      <p>If you're receiving this, the email service is working correctly.</p>
      <hr style="border: 1px solid #eee; margin: 20px 0;" />
      <p style="color: #666; font-size: 12px;">Sent at: ${new Date().toISOString()}</p>
    </div>
  `;
  
  try {
    const result = await emailService.sendEmail({
      to: TEST_EMAIL,
      subject,
      text,
      html
    });
    
    if (result) {
      console.log('✅ Email sent successfully!');
    } else {
      console.error('❌ Failed to send email. Check the logs for details.');
    }
  } catch (error) {
    console.error('❌ Error sending email:', error);
  }
  
  console.log('Email test completed.');
}

// Run the script
main().catch(error => {
  console.error('Unhandled error:', error);
  process.exit(1);
}); 