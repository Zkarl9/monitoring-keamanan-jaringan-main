import { NodeSSH } from 'node-ssh';

interface SSHConfig {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
}

const SSH_CONFIG: SSHConfig = {
  host: process.env.CENTOS_HOST || '172.27.117.12',
  port: parseInt(process.env.CENTOS_PORT || '22'),
  username: process.env.CENTOS_USER || 'haikal',
  password: process.env.CENTOS_PASSWORD || 'Kallvj123',
};

class SSHConnection {
  private ssh: NodeSSH;
  private connected: boolean = false;

  constructor() {
    this.ssh = new NodeSSH();
  }

  async connect() {
    if (this.connected) return;
    
    try {
      await this.ssh.connect(SSH_CONFIG);
      this.connected = true;
      console.log('✓ SSH Connected to CentOS');
    } catch (error) {
      console.error('✗ SSH Connection failed:', error);
      this.connected = false;
      throw error;
    }
  }

  async exec(command: string): Promise<string> {
    if (!this.connected) await this.connect();

    try {
      const result = await this.ssh.execCommand(command);
      if (result.code !== 0 && result.stderr) {
        throw new Error(result.stderr);
      }
      return result.stdout;
    } catch (error) {
      console.error('Command execution error:', error);
      this.connected = false;
      throw error;
    }
  }

  // Exec dengan input (mis. untuk sudo -S)
  async execWithInput(command: string, input?: string): Promise<string> {
    if (!this.connected) await this.connect();

    try {
      const result = await this.ssh.execCommand(command, { stdin: input });
      if (result.code !== 0 && result.stderr) {
        // Kembalikan stderr agar caller bisa memeriksa pesan
        throw new Error(result.stderr);
      }
      return result.stdout;
    } catch (error) {
      console.error('Command execution error (with input):', error);
      this.connected = false;
      throw error;
    }
  }

  // Helper untuk menjalankan perintah dengan sudo non-interaktif menggunakan -S
  async execSudo(command: string): Promise<string> {
    const password = SSH_CONFIG.password || '';
    // -S : read password from stdin, -p '' : no prompt
    const sudoCmd = `sudo -S -p '' ${command}`;
    return await this.execWithInput(sudoCmd, password + '\n');
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.exec('echo 1');
      return true;
    } catch (error) {
      console.error('SSH test connection failed:', error);
      return false;
    }
  }

  async readFile(path: string): Promise<string> {
    return await this.exec(`cat ${path}`);
  }

  isConnected(): boolean {
    return this.connected;
  }

  disconnect() {
    if (this.ssh) {
      this.ssh.dispose();
      this.connected = false;
    }
  }
}

export const sshConnection = new SSHConnection();