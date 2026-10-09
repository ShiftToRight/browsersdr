import packageInfo from "../../package.json";
import thirdPartyNotices from "../../THIRD_PARTY_NOTICES.md?raw";
import { VisitorCounter } from "./VisitorCounter";

const buildId = import.meta.env.VITE_BUILD_ID || "development";
const builtAt = import.meta.env.VITE_BUILD_TIMESTAMP || "local build";

export function AboutPage() {
  return (
    <div className="about-page">
      <section className="about-hero" aria-labelledby="about-heading">
        <div>
          <p className="eyebrow">About BrowserSDR</p>
          <h2 id="about-heading">Licences, privacy &amp; provenance</h2>
          <p>
            BrowserSDR is a receive-only radio application that processes RF,
            decoded content, recordings and audio locally in this browser tab.
          </p>
        </div>
        <dl className="about-build">
          <div>
            <dt>Version</dt>
            <dd>{packageInfo.version}</dd>
          </div>
          <div>
            <dt>Build</dt>
            <dd>{buildId}</dd>
          </div>
          <div>
            <dt>Built</dt>
            <dd>{builtAt}</dd>
          </div>
        </dl>
      </section>

      <div className="about-grid">
        <section
          className="about-panel"
          aria-labelledby="application-licence-heading"
        >
          <p className="eyebrow">Application terms</p>
          <h3 id="application-licence-heading">BrowserSDR licence</h3>
          <p>
            Until one is published by the copyright holder, no open-source
            licence is granted for BrowserSDR itself. Third-party components
            retain their own licences, listed below.
          </p>
          <p>
            BrowserSDR is provided without a promise that reception will be
            continuous, complete or suitable for safety-critical use. Users are
            responsible for following local radio and data-protection laws.
          </p>
        </section>

        <section
          className="about-panel"
          id="about-privacy"
          aria-labelledby="privacy-heading"
        >
          <p className="eyebrow">Privacy</p>
          <h3 id="privacy-heading">
            Local radio processing; explicit remote connections
          </h3>
          <p>
            Local reception and replay are processed in your browser. Saving to
            SigIntAtlas is an explicit upload. Connecting to OpenWebRX or KiwiSDR contacts
            the receiver operator, who can see the connection and tuning
            requests; its audio and spectrum are processed remotely. BrowserSDR
            does not forward local captures or Atlas credentials to that receiver.
          </p>
          <p>
            Automatic error reporting is on by default. You can turn it off in
            Diagnostics; a saved opt-out is respected. Compatibility reports
            require review and manual submission. Reports can
            contain app errors, bounded performance counters, a coarse browser
            and operating-system description, receiver configuration and an
            optional description. Exact tuned frequency is excluded unless you
            explicitly include it.
          </p>
          <p>
            Visitor counts use existing server access logs, with known bots
            filtered out. Only the total is published; no analytics cookies or
            browser identifiers are added.
          </p>
        </section>
      </div>

      <section
        className="about-panel about-drivers"
        aria-labelledby="driver-heading"
      >
        <p className="eyebrow">Drivers &amp; device images</p>
        <h3 id="driver-heading">What ships, and what is imported</h3>
        <div className="about-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Component</th>
                <th>Delivery</th>
                <th>Licence / source</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">RTL-SDR browser driver</th>
                <td>Bundled</td>
                <td>@jtarrio/webrtlsdr 3.0.6 · Apache-2.0</td>
              </tr>
              <tr>
                <th scope="row">Signal-processing helpers</th>
                <td>Bundled</td>
                <td>@jtarrio/signals 0.10.1 · Apache-2.0</td>
              </tr>
              <tr>
                <th scope="row">AD9364 receive driver</th>
                <td>Bundled WebAssembly and reproducible source closure</td>
                <td>Analog Devices no-OS · BSD-3-Clause</td>
              </tr>
              <tr>
                <th scope="row">bladeRF FPGA image</th>
                <td>
                  Imported by the user from an advertised Nuand source; not
                  redistributed
                </td>
                <td>Exact version, size and digest are verified</td>
              </tr>
              <tr>
                <th scope="row">USRP B205 FX3 firmware and FPGA image</th>
                <td>
                  Imported by the user from pinned Ettus archives; not
                  redistributed
                </td>
                <td>
                  Verified before volatile RAM load; no flash or EEPROM write
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section
        className="about-panel legal-notices"
        aria-labelledby="notices-heading"
      >
        <p className="eyebrow">Attribution</p>
        <h3 id="notices-heading">Third-party notices</h3>
        <p>
          These notices apply independently of the licence eventually selected
          for BrowserSDR.
        </p>
        <details>
          <summary>Read detailed bundled notices</summary>
          <pre>{thirdPartyNotices}</pre>
        </details>
      </section>
      <VisitorCounter />
    </div>
  );
}
