#!/bin/bash

# 7일 동안 실제 DB 쿼리(REST API 호출 포함)가 단 한 건도 없으면 Supabase는 이 프로젝트를 휴면 상태로 판단하고 서버(Compute 인스턴스)를 잠재워 버린다.
# 이를 방지하고자 sbbs(Supabase 사용)를 주기적으로 요청한다.
# 단순히 curl -fsS https://ysoftman.github.io/sbbs/ 호출은 html 만 다운로드 하기 때문에 안된다.
# cron잡으로 등록해놓자.
# 0 */2 * * * bash /Users/ysoftman/workspace/sbbs/keep_alive.sh

# 1. 환경변수 파일 로드 및 가공
. $HOME/workspace/sbbs/.env

supabase_url=$(echo $VITE_SUPABASE_URL | tr -d '"')
supabase_pub_key=$(echo $VITE_SUPABASE_PUBLISHABLE_KEY | tr -d '"')

# 2. Supabase API 호출 및 로그 기록
# /rest/v1/ 루트 엔드포인트는 secret key 를 요구해 publishable key 로는 401 이 난다.
# 실제 테이블을 가볍게 쿼리해야 (1) 인증이 통과하고 (2) keep-alive 목적의 실제 DB 쿼리가 발생한다.
{
    # 시간 기록
    # printf %( 는 bash 전용이다. zsh 에선 에러 난다. -1 현재시각, -2 셀 프로세스 시작 시간
    # printf '%(%Y-%m-%d %H:%M:%S)T ' -1
    date "+%Y-%m-%d %H:%M:%S " | tr -d '\n'
    curl -fsS -X GET "$supabase_url/rest/v1/image_info?select=id&limit=1" \
        -H "apikey: $supabase_pub_key" \
        -H "Authorization: Bearer $supabase_pub_key" 2>&1
    echo ""
} >>$HOME/sbbs.log
