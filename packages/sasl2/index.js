import { encode, decode } from "@xmpp/base64";
import SASLError from "@xmpp/sasl/lib/SASLError.js";
import jid from "@xmpp/jid";
import xml from "@xmpp/xml";

// https://xmpp.org/extensions/xep-0388.html

const NS = "urn:xmpp:sasl:2";

function getMechanismNames(stanza) {
  return stanza.getChildren("mechanism", NS).map((m) => m.text());
}

async function authenticate({
  saslFactory,
  entity,
  mechanism,
  credentials,
  userAgent,
  sessionFeatures,
}) {
  const mech = saslFactory.create([mechanism]);
  if (!mech) {
    throw new Error(`SASL: Mechanism ${mechanism} not found.`);
  }

  const { domain } = entity.options;
  const creds = {
    username: null,
    password: null,
    server: domain,
    host: domain,
    realm: domain,
    serviceType: "xmpp",
    serviceName: domain,
    ...credentials,
  };

  return new Promise((resolve, reject) => {
    const handler = (element) => {
      if (element.attrs.xmlns !== NS) {
        return;
      }

      if (element.name === "challenge") {
        mech.challenge(decode(element.text()));
        const resp = mech.response(creds);
        entity.send(
          xml(
            "response",
            { xmlns: NS, mechanism: mech.name },
            typeof resp === "string" ? encode(resp) : "",
          ),
        );
        return;
      }

      if (element.name === "failure") {
        reject(SASLError.fromElement(element));
        return;
      }

      if (element.name === "continue") {
        // No tasks supported yet
        reject(new Error("continue is not supported yet"));
        return;
      }

      if (element.name === "success") {
        const additionalData = element.getChild("additional-data")?.text();
        if (additionalData && mech.final) {
          mech.final(decode(additionalData));
        }
        // This jid will be bare unless we do inline bind2 then it will be the bound full jid
        const aid = element.getChild("authorization-identifier")?.text();
        if (aid) {
          if (!entity.jid?.resource) {
            // No jid or bare jid, so update it
            entity._jid(aid);
          } else if (jid(aid).resource) {
            // We have a full jid so use it
            entity._jid(aid);
          }
        }
        resolve(element);
        return;
      }

      entity.removeListener("nonza", handler);
    };

    entity.on("nonza", handler);

    entity
      .send(
        xml("authenticate", { xmlns: NS, mechanism: mech.name }, [
          mech.clientFirst &&
            xml("initial-response", {}, encode(mech.response(creds))),
          userAgent,
          ...sessionFeatures,
        ]),
      )
      .catch(reject);
  });
}

export default function sasl2({ streamFeatures, saslFactory }, onAuthenticate) {
  // inline
  const features = new Map();

  streamFeatures.use(
    "authentication",
    NS,
    async ({ entity }, _next, element) => {
      const offered = getMechanismNames(element);
      const supported = saslFactory._mechs.map(({ name }) => name);
      const intersection = supported.filter((mech) => offered.includes(mech));

      if (intersection.length === 0) {
        throw new SASLError("SASL: No compatible mechanism available.");
      }

      const sessionFeatures = await getSessionFeatures({ element, features });

      async function done(credentials, mechanism, userAgent) {
        await authenticate({
          saslFactory,
          entity,
          mechanism,
          credentials,
          userAgent,
          sessionFeatures,
        });
      }

      await onAuthenticate(done, intersection);

      return true; // Not online yet, wait for next features
    },
  );

  return {
    use(ns, req, res) {
      features.set(ns, req, res);
    },
  };
}

function getSessionFeatures({ element, features }) {
  const promises = [];

  const inline = element.getChild("inline");
  if (!inline) return promises;

  for (const element of inline.getChildElements()) {
    const xmlns = element.getNS();
    const feature = features.get(xmlns);
    if (!feature) continue;
    promises.push(feature(element));
  }

  return Promise.all(promises);
}
