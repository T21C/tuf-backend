import { emailService } from '../utils/auth/email.js';
import { Command } from 'commander';

async function testEmail(email: string) {
    const emailSent = await emailService.sendVerificationEmail(email, 'test');
    console.log(emailSent);
}

const program = new Command();

program
  .name('test-email')
  .description('Test email sending')


program.command('test')
  .description('Test email sending')
  .option('-e, --email <email>', 'Email to send to', 'test@test.com')
  .action(async (options) => {
    await testEmail(options.email);
  });

program.parse(process.argv);
