import nodemailer from 'nodemailer';

// Create SMTP transporter using MailerSend
const transporter = nodemailer.createTransport({
  host: 'smtp.mailersend.net',
  port: 587,
  secure: false,
  auth: {
    user: process.env.MAILERSEND_SMTP_USER,
    pass: process.env.MAILERSEND_SMTP_PASSWORD
  }
});

interface EmailOptions {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export const emailService = {
  /**
   * Send an email using MailerSend SMTP
   */
  async sendEmail({ to, subject, text, html }: EmailOptions): Promise<boolean> {
    try {
      await transporter.sendMail({
        from: {
          name: 'TUF Community',
          address: process.env.MAILERSEND_FROM_EMAIL || 'noreply@tuf.community'
        },
        to,
        subject,
        text,
        html
      });
      return true;
    } catch (error) {
      console.error('Email sending failed:', error);
      return false;
    }
  },

  /**
   * Send verification email
   */
  async sendVerificationEmail(to: string, token: string): Promise<boolean> {
    const verificationUrl = `${process.env.FRONTEND_URL}/verify-email?token=${token}`;
    
    const subject = 'Verify your email address';
    const text = `
      Welcome to TUF!
      
      Please verify your email address by clicking the link below:
      ${verificationUrl}
      
      This link will expire in 24 hours.
      
      If you didn't create an account, you can safely ignore this email.
    `;
    const html = `
      <h2>Welcome to TUF!</h2>
      <p>Please verify your email address by clicking the link below:</p>
      <p>
        <a href="${verificationUrl}" style="
          background-color: #4CAF50;
          border: none;
          color: white;
          padding: 15px 32px;
          text-align: center;
          text-decoration: none;
          display: inline-block;
          font-size: 16px;
          margin: 4px 2px;
          cursor: pointer;
          border-radius: 4px;
        ">
          Verify Email Address
        </a>
      </p>
      <p>Or copy and paste this link in your browser:</p>
      <p>${verificationUrl}</p>
      <p>This link will expire in 24 hours.</p>
      <p><small>If you didn't create an account, you can safely ignore this email.</small></p>
    `;

    return this.sendEmail({ to, subject, text, html });
  },

  /**
   * Send password reset email
   */
  async sendPasswordResetEmail(to: string, token: string): Promise<boolean> {
    const resetUrl = `${process.env.FRONTEND_URL}/reset-password?token=${token}`;
    
    const subject = 'Reset your password';
    const text = `
      You requested to reset your password.
      
      Please click the link below to reset your password:
      ${resetUrl}
      
      This link will expire in 1 hour.
      
      If you didn't request a password reset, you can safely ignore this email.
    `;
    const html = `
      <h2>Reset Your Password</h2>
      <p>You requested to reset your password.</p>
      <p>Please click the button below to reset your password:</p>
      <p>
        <a href="${resetUrl}" style="
          background-color: #4CAF50;
          border: none;
          color: white;
          padding: 15px 32px;
          text-align: center;
          text-decoration: none;
          display: inline-block;
          font-size: 16px;
          margin: 4px 2px;
          cursor: pointer;
          border-radius: 4px;
        ">
          Reset Password
        </a>
      </p>
      <p>Or copy and paste this link in your browser:</p>
      <p>${resetUrl}</p>
      <p>This link will expire in 1 hour.</p>
      <p><small>If you didn't request a password reset, you can safely ignore this email.</small></p>
    `;

    return this.sendEmail({ to, subject, text, html });
  }
}; 