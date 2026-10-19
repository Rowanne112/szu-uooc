#!/bin/bash
# shortcut: reads static HTTPS proxies; add PAC/SOCKS discovery if those configurations are needed.

szu_mac_network() {
  local proxy bypass host
  if [ -z "${https_proxy:-}${HTTPS_PROXY:-}" ]; then
    proxy="${all_proxy:-${ALL_PROXY:-}}"
    if [ -z "$proxy" ]; then
      proxy=$(PATH="$PATH:/usr/sbin" scutil --proxy 2>/dev/null | awk '
      $1 == "HTTPSEnable" && $2 == ":" { enabled = $3; if (NF != 3) invalid = 1 }
      $1 == "HTTPSProxy" && $2 == ":" { host = $3; if (NF != 3) invalid = 1 }
      $1 == "HTTPSPort" && $2 == ":" { port = $3; if (NF != 3) invalid = 1 }
      END {
        if (invalid || enabled != "1" || port !~ /^[0-9]+$/ || port < 1 || port > 65535 || !length(host) || length(host) > 253) exit
        count = split(host, labels, ".")
        for (i = 1; i <= count; i++) {
          if (length(labels[i]) > 63 || labels[i] !~ /^[[:alnum:]]([[:alnum:]-]*[[:alnum:]])?$/) exit
        }
        if (host ~ /^[0-9.]+$/) {
          if (count != 4) exit
          for (i = 1; i <= count; i++) if (labels[i] > 255) exit
        }
        print "http://" host ":" (port + 0)
      }') || proxy=""
    fi
    if [ -n "$proxy" ]; then export https_proxy="$proxy" HTTPS_PROXY="$proxy"; fi
  fi
  bypass="${no_proxy:-}"
  if [ -n "${NO_PROXY:-}" ] && [ "${NO_PROXY:-}" != "$bypass" ]; then bypass="${bypass:+$bypass,}$NO_PROXY"; fi
  for host in localhost 127.0.0.1 ::1; do
    case ",$bypass," in
      *",$host,"*) ;;
      *) bypass="${bypass:+$bypass,}$host" ;;
    esac
  done
  export no_proxy="$bypass" NO_PROXY="$bypass"
}
szu_mac_network
unset -f szu_mac_network
