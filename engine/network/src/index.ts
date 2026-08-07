/**
 * @papyrus/network — Iroh-based P2P networking for Papyrus.
 *
 * Each peer runs an Iroh endpoint. Projects are stored locally in SQLite.
 * Peers discover each other via Iroh's mDNS (LAN) or DERP relays (WAN).
 * Sync happens over QUIC bidirectional streams.
 */
export { PapyrusNetwork, type NetworkProject, type PeerInfo, type NetworkStats } from './iroh.js'
