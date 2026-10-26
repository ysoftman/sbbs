import index from "./index.html";

// Supabase Redirect URLs / Google OAuth origins 에 등록된 http://localhost:5173/sbbs/ 를 유지한다.
// env/define 설정은 bunfig.toml [serve.static] 에 있다.
Bun.serve({ port: 5173, development: true, routes: { "/sbbs/": index, "/sbbs/index.html": index } });
console.log("http://localhost:5173/sbbs/");
