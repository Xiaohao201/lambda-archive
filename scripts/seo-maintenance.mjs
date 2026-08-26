import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

const root = process.cwd();
const apply = process.argv.includes("--apply");
const siteOrigin = "https://lambdaarchive.com";
const siteName = "Lambda Archive";
const defaultImage = `${siteOrigin}/og-image.png`;
const runDate = new Date().toISOString().slice(0, 10);

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      if ([".git", ".github", "node_modules", "scripts"].includes(entry.name)) return [];
      return walk(fullPath);
    }
    return entry.name === "index.html" ? [fullPath] : [];
  });
}

function decodeHtml(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&lambda;/g, "λ")
    .replace(/&#(\d+);/g, (_, number) => String.fromCodePoint(Number(number)))
    .replace(/&#x([\da-f]+);/gi, (_, number) => String.fromCodePoint(parseInt(number, 16)));
}

function gitDate(relativePath, first = false) {
  const args = ["-c", "core.excludesFile=.git/info/exclude", "log"];
  if (first) args.push("--follow", "--diff-filter=A");
  else args.push("-1");
  args.push("--format=%cs", "--", relativePath);
  const lines = execFileSync("git", args, { cwd: root, encoding: "utf8" })
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  return first ? lines.at(-1) : lines[0];
}

function modifiedDate(relativePath) {
  const status = execFileSync(
    "git",
    ["-c", "core.excludesFile=.git/info/exclude", "status", "--porcelain", "--", relativePath],
    { cwd: root, encoding: "utf8" },
  ).trim();
  return status ? runDate : gitDate(relativePath);
}

function extract(content, pattern, label, file) {
  const match = content.match(pattern);
  if (!match) throw new Error(`${file}: missing ${label}`);
  return decodeHtml(match[1].trim());
}

function routeFor(file) {
  const rel = relative(root, file).split(sep).join("/");
  return rel === "index.html" ? "/" : `/${dirname(rel).split(sep).join("/")}/`;
}

function pageType(route) {
  if (route === "/about/") return "AboutPage";
  if (route === "/contact/") return "ContactPage";
  if (["/mods/", "/voices/", "/platforms/", "/characters/", "/versions/"].includes(route)) {
    return "CollectionPage";
  }
  return "WebPage";
}

function jsonScript(data, marker) {
  const json = JSON.stringify(data, null, 2)
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
  return `  <script type="application/ld+json" data-seo-entity="${marker}">\n${json}\n  </script>`;
}

function enrichContentSchema(content, canonical, published, modified, title, description) {
  return content.replace(
    /<script\b[^>]*\btype="application\/ld\+json"[^>]*>\s*([\s\S]*?)\s*<\/script>/g,
    (whole, rawJson) => {
      let data;
      try {
        data = JSON.parse(rawJson);
      } catch {
        return whole;
      }
      if (["WebPage", "CollectionPage", "AboutPage", "ContactPage"].includes(data["@type"])) {
        data["@id"] = `${canonical}#webpage`;
        data.url = canonical;
        data.name = title;
        data.description = description;
        data.isPartOf = { "@id": `${siteOrigin}/#website` };
        data.primaryImageOfPage = { "@type": "ImageObject", url: defaultImage };
        data.datePublished = published;
        data.dateModified = modified;
        data.inLanguage = "en-US";
        return jsonScript(data, "webpage").trimStart();
      }
      if (!["Article", "HowTo"].includes(data["@type"])) return whole;

      const suffix = data["@type"] === "HowTo" ? "howto" : "article";
      data["@id"] = `${canonical}#${suffix}`;
      data.url = canonical;
      data.image = {
        "@type": "ImageObject",
        url: defaultImage,
        width: 1200,
        height: 630,
      };
      data.datePublished = published;
      data.dateModified = modified;
      data.inLanguage = "en-US";
      data.author = {
        "@type": "Organization",
        "@id": `${siteOrigin}/#organization`,
        name: siteName,
        url: `${siteOrigin}/`,
        publishingPrinciples: `${siteOrigin}/about/`,
      };
      data.publisher = {
        "@type": "Organization",
        "@id": `${siteOrigin}/#organization`,
        name: siteName,
        url: `${siteOrigin}/`,
        logo: {
          "@type": "ImageObject",
          url: defaultImage,
          width: 1200,
          height: 630,
        },
      };
      data.isPartOf = {
        "@type": "WebSite",
        "@id": `${siteOrigin}/#website`,
        name: siteName,
        url: `${siteOrigin}/`,
      };
      data.mainEntityOfPage = { "@id": `${canonical}#webpage` };
      return jsonScript(data, suffix).trimStart();
    },
  );
}

function enhancePage(file, forcedModified) {
  const rel = relative(root, file).split(sep).join("/");
  const route = routeFor(file);
  const canonical = `${siteOrigin}${route}`;
  const originalContent = readFileSync(file, "utf8");
  let content = originalContent;
  const title = extract(content, /<title>([\s\S]*?)<\/title>/, "title", rel);
  const description = extract(
    content,
    /<meta name="description" content="([\s\S]*?)">/,
    "meta description",
    rel,
  );
  const actualCanonical = extract(
    content,
    /<link rel="canonical" href="([^"]+)">/,
    "canonical URL",
    rel,
  );
  if (actualCanonical !== canonical) {
    throw new Error(`${rel}: canonical is ${actualCanonical}; expected ${canonical}`);
  }

  const published = gitDate(rel, true);
  const modified = forcedModified ?? modifiedDate(rel);
  if (!published || !modified) throw new Error(`${rel}: no Git date available`);

  if (!apply) return { rel, canonical, published, modified, content };

  content = content.replace(
    /<meta name="robots" content="[^"]+">/,
    '<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1">',
  );
  content = content.replaceAll('rel="nofollow noopener"', 'rel="noopener noreferrer"');

  if (!content.includes('property="og:image"')) {
    content = content.replace(
      /  <meta name="twitter:card"/,
      `  <meta property="og:image" content="${defaultImage}">\n  <meta name="twitter:card"`,
    );
  }
  if (!content.includes('property="og:image:width"')) {
    content = content.replace(
      /  <meta name="twitter:card"/,
      `  <meta property="og:image:width" content="1200">\n  <meta property="og:image:height" content="630">\n  <meta property="og:image:alt" content="${siteName} — Half-Life reference site">\n  <meta name="twitter:card"`,
    );
  }

  const hasArticle = /"@type"\s*:\s*"(?:Article|HowTo)"/.test(content);
  if (hasArticle) {
    content = content
      .replace(
        /<meta property="article:published_time" content="[^"]+">/,
        `<meta property="article:published_time" content="${published}">`,
      )
      .replace(
        /<meta property="article:modified_time" content="[^"]+">/,
        `<meta property="article:modified_time" content="${modified}">`,
      );
    if (!content.includes('property="article:published_time"')) {
      content = content.replace(
        /  <meta property="og:site_name"/,
        `  <meta property="article:published_time" content="${published}">\n  <meta property="article:modified_time" content="${modified}">\n  <meta property="og:site_name"`,
      );
    }
  }

  content = enrichContentSchema(content, canonical, published, modified, title, description);

  if (route === "/") {
    content = content.replace(
      /  <script\b[^>]*\btype="application\/ld\+json"[^>]*>\s*\{[\s\S]*?"@type": "WebSite"[\s\S]*?<\/script>/,
      jsonScript(
        {
          "@context": "https://schema.org",
          "@graph": [
            {
              "@type": "Organization",
              "@id": `${siteOrigin}/#organization`,
              name: siteName,
              url: `${siteOrigin}/`,
              email: "contact@lambdaarchive.com",
              publishingPrinciples: `${siteOrigin}/about/`,
              logo: {
                "@type": "ImageObject",
                url: defaultImage,
                width: 1200,
                height: 630,
              },
              description:
                "Independent, fan-run reference for Half-Life mods, voice lines, versions, characters and platform guides.",
            },
            {
              "@type": "WebSite",
              "@id": `${siteOrigin}/#website`,
              name: siteName,
              url: `${siteOrigin}/`,
              description,
              publisher: { "@id": `${siteOrigin}/#organization` },
              inLanguage: "en-US",
            },
            {
              "@type": "WebPage",
              "@id": `${siteOrigin}/#webpage`,
              url: `${siteOrigin}/`,
              name: title,
              description,
              isPartOf: { "@id": `${siteOrigin}/#website` },
              about: [
                { "@type": "VideoGame", name: "Half-Life" },
                { "@type": "VideoGame", name: "Half-Life 2" },
              ],
              primaryImageOfPage: { "@type": "ImageObject", url: defaultImage },
              datePublished: published,
              dateModified: modified,
              inLanguage: "en-US",
            },
          ],
        },
        "site-graph",
      ),
    );
  } else if (!content.includes('data-seo-entity="webpage"')) {
    const webpage = {
      "@context": "https://schema.org",
      "@type": pageType(route),
      "@id": `${canonical}#webpage`,
      url: canonical,
      name: title,
      description,
      isPartOf: { "@id": `${siteOrigin}/#website` },
      about: [
        { "@type": "VideoGame", name: "Half-Life" },
        { "@type": "VideoGame", name: "Half-Life 2" },
      ],
      primaryImageOfPage: { "@type": "ImageObject", url: defaultImage },
      datePublished: published,
      dateModified: modified,
      inLanguage: "en-US",
    };
    if (hasArticle) {
      const suffix = /"@type"\s*:\s*"HowTo"/.test(content) ? "howto" : "article";
      webpage.mainEntity = { "@id": `${canonical}#${suffix}` };
    }
    content = content.replace("</head>", `${jsonScript(webpage, "webpage")}\n</head>`);
  }

  if (content !== originalContent && modified !== runDate) {
    return enhancePage(file, runDate);
  }
  if (apply) writeFileSync(file, content, "utf8");
  return { rel, canonical, published, modified, content };
}

function validate(pages) {
  const errors = [];
  const titles = new Map();
  const descriptions = new Map();
  const canonicals = new Set();

  for (const page of pages) {
    const { rel, canonical, modified, content } = page;
    const title = extract(content, /<title>([\s\S]*?)<\/title>/, "title", rel);
    const description = extract(
      content,
      /<meta name="description" content="([\s\S]*?)">/,
      "description",
      rel,
    );
    const h1Count = (content.match(/<h1(?:\s|>)/g) || []).length;
    if (h1Count !== 1) errors.push(`${rel}: expected one H1, found ${h1Count}`);
    if (!content.includes("max-image-preview:large, max-snippet:-1, max-video-preview:-1")) {
      errors.push(`${rel}: incomplete robots preview directives`);
    }
    if (!content.includes('property="og:image:width"') || !content.includes('property="og:image:alt"')) {
      errors.push(`${rel}: incomplete Open Graph image metadata`);
    }
    if (
      !content.includes('data-seo-entity="webpage"') &&
      !content.includes('data-seo-entity="site-graph"')
    ) {
      errors.push(`${rel}: missing page entity schema`);
    }
    if (canonicals.has(canonical)) errors.push(`${rel}: duplicate canonical ${canonical}`);
    canonicals.add(canonical);
    if (titles.has(title)) errors.push(`${rel}: duplicate title also used by ${titles.get(title)}`);
    titles.set(title, rel);
    if (descriptions.has(description)) {
      errors.push(`${rel}: duplicate description also used by ${descriptions.get(description)}`);
    }
    descriptions.set(description, rel);

    for (const match of content.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
      try {
        JSON.parse(match[1]);
      } catch (error) {
        errors.push(`${rel}: invalid JSON-LD (${error.message})`);
      }
    }
    if (/"@type"\s*:\s*"(?:Article|HowTo)"/.test(content)) {
      if (!content.includes('property="article:published_time"')) {
        errors.push(`${rel}: missing article publication metadata`);
      }
      if (!content.includes('"datePublished"') || !content.includes('"dateModified"')) {
        errors.push(`${rel}: missing structured article dates`);
      }
      const openGraphModified = content.match(/article:modified_time" content="([^"]+)"/)?.[1];
      const structuredModified = content.match(/"dateModified": "([^"]+)"/)?.[1];
      if (openGraphModified !== modified || structuredModified !== modified) {
        errors.push(`${rel}: article modified dates do not match ${modified}`);
      }
    }

    for (const match of content.matchAll(/href="(\/[^"]*)"/g)) {
      const href = match[1].split(/[?#]/)[0];
      if (!href || href === "/") continue;
      const target = href.endsWith("/") ? join(root, href, "index.html") : join(root, href);
      if (!existsSync(target) || !statSync(target).isFile()) {
        errors.push(`${rel}: broken internal link ${href}`);
      }
    }
  }

  const sitemap = readFileSync(join(root, "sitemap.xml"), "utf8");
  const sitemapUrls = new Set([...sitemap.matchAll(/<loc>(.*?)<\/loc>/g)].map((match) => match[1]));
  for (const canonical of canonicals) {
    if (!sitemapUrls.has(canonical)) errors.push(`sitemap.xml: missing ${canonical}`);
  }
  for (const url of sitemapUrls) {
    if (!canonicals.has(url)) errors.push(`sitemap.xml: URL has no page ${url}`);
  }
  const lastModifiedEntries = new Map(
    [...sitemap.matchAll(/<loc>(.*?)<\/loc>\s*<lastmod>(.*?)<\/lastmod>/g)].map((match) => [
      match[1],
      match[2],
    ]),
  );
  for (const page of pages) {
    if (lastModifiedEntries.get(page.canonical) !== page.modified) {
      errors.push(`sitemap.xml: incorrect or missing lastmod for ${page.canonical}`);
    }
  }

  const robots = readFileSync(join(root, "robots.txt"), "utf8");
  if (!robots.includes(`Sitemap: ${siteOrigin}/sitemap.xml`)) {
    errors.push("robots.txt: missing absolute sitemap declaration");
  }
  const llms = readFileSync(join(root, "llms.txt"), "utf8");
  if (!llms.includes("# Lambda Archive") || !llms.includes(`${siteOrigin}/about/`)) {
    errors.push("llms.txt: missing site identity or editorial-method link");
  }
  const notFound = readFileSync(join(root, "404.html"), "utf8");
  if (!notFound.includes('name="robots" content="noindex, follow"')) {
    errors.push("404.html: must remain noindex, follow");
  }

  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
    return;
  }
  console.log(`SEO validation passed: ${pages.length} pages, ${sitemapUrls.size} sitemap URLs.`);
}

const pages = walk(root).map((file) => enhancePage(file));
if (apply) {
  const sitemapPath = join(root, "sitemap.xml");
  let sitemap = readFileSync(sitemapPath, "utf8");
  for (const page of pages) {
    const escaped = page.canonical.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const entry = new RegExp(`(<loc>${escaped}<\\/loc>)(?:\\s*<lastmod>.*?<\\/lastmod>)?`);
    sitemap = sitemap.replace(entry, `$1\n    <lastmod>${page.modified}</lastmod>`);
  }
  writeFileSync(sitemapPath, sitemap, "utf8");
}
validate(pages);
