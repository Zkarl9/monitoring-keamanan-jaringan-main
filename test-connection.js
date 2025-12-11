const { NodeSSH } = require('node-ssh');

async function testConnection() {
  const ssh = new NodeSSH();
  
  try {
    console.log('🔌 Connecting to CentOS...');
    await ssh.connect({
      host: '192.168.0.117', // Ganti dengan IP CentOS Anda
      port: 22,
      username: 'haikal',
      password: 'Kallvj123' // Ganti dengan password Anda
    });
    console.log('✅ SSH Connected!');
    
    console.log('\n📖 Reading Suricata log...');
    const result = await ssh.execCommand('tail -10 /var/log/suricata/eve.json');
    console.log('Log sample:');
    console.log(result.stdout);
    
    console.log('\n🔥 Testing firewall command...');
    const fwTest = await ssh.execCommand('sudo firewall-cmd --version');
    console.log('Firewall version:', fwTest.stdout);
    
    ssh.dispose();
    console.log('\n✅ All tests passed!');
  } catch (error) {
    console.error('❌ Test failed:', error);
  }
}

testConnection();