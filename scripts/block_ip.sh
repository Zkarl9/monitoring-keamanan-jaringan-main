#!/bin/bash
# Block/Unblock IP helper script for firewall management
# Usage: /usr/local/sbin/block_ip.sh [--remove] <ip>

ACTION="block"  # default
IP=""

# Parse arguments
if [ "$1" = "--remove" ]; then
  ACTION="unblock"
  IP="$2"
else
  IP="$1"
fi

if [ -z "$IP" ]; then
  echo "usage: $0 [--remove] <ip>" >&2
  exit 2
fi

# Validate IP format
if ! echo "$IP" | grep -qE '^([0-9]{1,3}\.){3}[0-9]{1,3}$'; then
  echo "invalid ip: $IP" >&2
  exit 2
fi

# === BLOCK ACTION ===
if [ "$ACTION" = "block" ]; then
  echo "[*] Blocking IP: $IP"
  
  # Try firewalld first
  if command -v firewall-cmd >/dev/null 2>&1; then
    echo "[*] Attempting firewall-cmd..."
    if firewall-cmd --permanent --add-rich-rule="rule family='ipv4' source address='${IP}' reject" 2>/dev/null; then
      if firewall-cmd --reload 2>/dev/null; then
        if firewall-cmd --list-rich-rules 2>/dev/null | grep -qF "$IP"; then
          echo "[+] Successfully blocked via firewall-cmd"
          exit 0
        fi
      fi
    fi
  fi
  
  # Fallback to iptables
  if command -v iptables >/dev/null 2>&1; then
    echo "[*] Attempting iptables..."
    if iptables -I INPUT -s "$IP" -j DROP 2>/dev/null; then
      # Save rules
      if command -v service >/dev/null 2>&1 && service iptables save 2>/dev/null; then
        :
      elif command -v iptables-save >/dev/null 2>&1; then
        iptables-save 2>/dev/null | tee /etc/sysconfig/iptables >/dev/null || true
      fi
      
      if iptables -L INPUT -n 2>/dev/null | grep -qF "$IP"; then
        echo "[+] Successfully blocked via iptables"
        exit 0
      fi
    fi
  fi
  
  # Fallback to hosts.deny
  if [ -w "/etc/hosts.deny" ]; then
    echo "[*] Attempting hosts.deny..."
    if ! grep -qF "$IP" /etc/hosts.deny 2>/dev/null; then
      echo "ALL: $IP" >> /etc/hosts.deny
      echo "[+] Successfully blocked via hosts.deny"
      exit 0
    fi
  fi
  
  echo "[-] Failed to block IP" >&2
  exit 1

# === UNBLOCK ACTION ===
elif [ "$ACTION" = "unblock" ]; then
  echo "[*] Unblocking IP: $IP"
  
  UNBLOCKED=0
  
  # Remove from firewalld
  if command -v firewall-cmd >/dev/null 2>&1; then
    echo "[*] Attempting firewall-cmd removal..."
    if firewall-cmd --permanent --remove-rich-rule="rule family='ipv4' source address='${IP}' reject" 2>/dev/null; then
      if firewall-cmd --reload 2>/dev/null; then
        if ! firewall-cmd --list-rich-rules 2>/dev/null | grep -qF "$IP"; then
          echo "[+] Removed from firewall-cmd"
          UNBLOCKED=1
        fi
      fi
    fi
  fi
  
  # Remove from iptables
  if command -v iptables >/dev/null 2>&1; then
    echo "[*] Attempting iptables removal..."
    while iptables -C INPUT -s "$IP" -j DROP >/dev/null 2>&1; do
      if iptables -D INPUT -s "$IP" -j DROP 2>/dev/null; then
        UNBLOCKED=1
      fi
    done
    
    # Save if removed
    if [ "$UNBLOCKED" -eq 1 ]; then
      if command -v service >/dev/null 2>&1 && service iptables save 2>/dev/null; then
        echo "[+] Removed from iptables and saved"
      elif command -v iptables-save >/dev/null 2>&1; then
        iptables-save 2>/dev/null | tee /etc/sysconfig/iptables >/dev/null || true
        echo "[+] Removed from iptables and saved"
      fi
    fi
  fi
  
  # Remove from hosts.deny
  if [ -w "/etc/hosts.deny" ] && grep -qF "$IP" /etc/hosts.deny 2>/dev/null; then
    echo "[*] Attempting hosts.deny removal..."
    sed -i "/$(echo "$IP" | sed 's/\./\\./g')/d" /etc/hosts.deny
    if ! grep -qF "$IP" /etc/hosts.deny 2>/dev/null; then
      echo "[+] Removed from hosts.deny"
      UNBLOCKED=1
    fi
  fi
  
  if [ "$UNBLOCKED" -eq 1 ]; then
    echo "[+] Successfully unblocked IP"
    exit 0
  else
    echo "[-] Failed to unblock IP or IP was not blocked" >&2
    exit 1
  fi
fi
